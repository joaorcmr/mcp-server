import { getManagementConfig } from "../config/env.js";
import { redactSecrets } from "./redact.js";
import type { BotContent, BotSummary, Conversation } from "./types.js";

/**
 * Camada de acesso à Management API do Botpress (https://api.botpress.cloud).
 *
 * IMPORTANTE — esta camada é SOMENTE LEITURA por design. A Management API não
 * expõe escrita para fluxos, hooks, guidelines de agentes nem code actions:
 * esses artefatos vivem apenas no Studio e chegam à API como um arquivo de
 * deploy read-only. O que é gravável (config de integração, arquivos de KB,
 * tables) tem efeito IMEDIATO no bot publicado — ou seja, equivale a publicar.
 * Por isso nenhuma função aqui faz POST/PUT/PATCH/DELETE.
 */

interface FetchOptions {
  /** Envia o header x-bot-id (necessário em endpoints com escopo de bot). */
  botId?: string;
  /** Query string já montada, sem o "?". */
  query?: Record<string, string | number | undefined>;
}

async function bpFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, workspaceId, apiUrl } = getManagementConfig();

  const url = new URL(path, apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-workspace-id": workspaceId,
  };
  if (options.botId) headers["x-bot-id"] = options.botId;

  const response = await withRetry(
    () => fetch(url, { headers }),
    `GET ${path}`,
  );
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Botpress API ${response.status} em ${path}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Resposta não-JSON da Botpress API em ${path}: ${text.slice(0, 300)}`,
    );
  }
}

/**
 * Repete a chamada em falhas transitórias de rede.
 *
 * Um cliente MCP dispara várias tools em paralelo, e cada uma pode puxar o
 * conteúdo do bot (~1,8 MB). Sem retry, uma conexão derrubada no meio faz a
 * tool inteira falhar com um "fetch failed" sem contexto.
 */
async function withRetry(
  operation: () => Promise<Response>,
  label: string,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Falha de rede em ${label} após ${attempts} tentativas: ${detail}`);
}

/** Lista todos os bots do workspace, seguindo a paginação até o fim. */
export async function listBots(): Promise<BotSummary[]> {
  const bots: BotSummary[] = [];
  let nextToken: string | undefined;

  do {
    const page = await bpFetch<{
      bots: BotSummary[];
      meta?: { nextToken?: string };
    }>("/v1/admin/bots", { query: { nextToken } });

    bots.push(...(page.bots ?? []));
    nextToken = page.meta?.nextToken;
  } while (nextToken);

  return bots;
}

/** Detalhe de um bot: configuração, integrações, status. Segredos redigidos. */
export async function getBot(botId: string): Promise<Record<string, any>> {
  const { bot } = await bpFetch<{ bot: Record<string, any> }>(
    `/v1/admin/bots/${botId}`,
  );
  return redactSecrets(bot);
}

/**
 * Conteúdo DEPLOYADO do bot: fluxos, KBs, hooks, actions, tables, settings.
 *
 * Atenção: é o snapshot da última publicação, não o rascunho atual do Studio.
 * Se alguém editou sem publicar, essas mudanças NÃO aparecem aqui.
 */
async function fetchBotContent(
  botId: string,
  bot: Record<string, any>,
): Promise<BotContent> {
  const contentFileId: string | undefined = bot?.tags?.botContentFileId;

  if (!contentFileId) {
    throw new Error(
      `Bot ${botId} não tem tags.botContentFileId — provavelmente nunca foi publicado.`,
    );
  }

  const { file } = await bpFetch<{ file: { url: string } }>(
    `/v1/files/${contentFileId}`,
    { botId },
  );

  // A URL é pré-assinada (S3): não deve levar o header de Authorization.
  const download = await withRetry(
    () => fetch(file.url),
    `download do conteúdo de ${botId}`,
  );
  if (!download.ok) {
    throw new Error(
      `Falha ao baixar o conteúdo do bot (${download.status}) de ${contentFileId}.`,
    );
  }

  const content = (await download.json()) as BotContent;
  return redactSecrets(content) as BotContent;
}

// ---------------------------------------------------------------------------
// Cache do conteúdo
//
// O arquivo de conteúdo do bot principal tem ~1,8 MB e várias tools o consomem
// na mesma sessão (grep, inspeção de fluxo, diff), então baixar de novo a cada
// chamada é desperdício.
//
// Duas proteções:
//  - TTL: passado o prazo, confere o deployedAt antes de rebaixar. Uma
//    publicação nova invalida o cache automaticamente.
//  - Deduplicação de chamadas em voo: um cliente MCP dispara tools em paralelo,
//    e sem isso duas tools baixariam os mesmos 1,8 MB simultaneamente — foi o
//    que provocou "fetch failed" no teste de duas tools concorrentes.
// ---------------------------------------------------------------------------

interface CacheEntry {
  deployedAt: string;
  fetchedAt: number;
  content: BotContent;
}

const contentCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<BotContent>>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function getBotContent(
  botId: string,
  options: { refresh?: boolean } = {},
): Promise<BotContent> {
  const cached = contentCache.get(botId);
  const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (cached && isFresh && !options.refresh) {
    return cached.content;
  }

  // Já existe um download em andamento para este bot: aguarda o mesmo resultado.
  const pending = inFlight.get(botId);
  if (pending && !options.refresh) return pending;

  const promise = loadBotContent(botId, cached, options.refresh ?? false).finally(
    () => {
      inFlight.delete(botId);
    },
  );

  inFlight.set(botId, promise);
  return promise;
}

async function loadBotContent(
  botId: string,
  cached: CacheEntry | undefined,
  refresh: boolean,
): Promise<BotContent> {
  const bot = await getBot(botId);
  const deployedAt: string = bot?.deployedAt ?? "";

  // Fora do TTL mas sem republicação: revalida o cache sem rebaixar 1,8 MB.
  if (cached && !refresh && deployedAt === cached.deployedAt) {
    cached.fetchedAt = Date.now();
    return cached.content;
  }

  const content = await fetchBotContent(botId, bot);

  contentCache.set(botId, {
    deployedAt,
    fetchedAt: Date.now(),
    content,
  });

  return content;
}

/** Conversas recentes de um bot (Chat/runtime API). Bom proxy de tráfego real. */
export async function listConversations(
  botId: string,
  limit = 20,
): Promise<Conversation[]> {
  const { conversations } = await bpFetch<{ conversations: Conversation[] }>(
    "/v1/chat/conversations",
    { botId, query: { limit } },
  );
  return conversations ?? [];
}

/** Tables do bot (schema, não os registros). */
export async function listTables(botId: string): Promise<Record<string, any>[]> {
  const { tables } = await bpFetch<{ tables: Record<string, any>[] }>(
    "/v1/tables",
    { botId },
  );
  return tables ?? [];
}

/** Arquivos indexados nas knowledge bases do bot. */
export async function listKnowledgeBaseFiles(
  botId: string,
): Promise<Record<string, any>[]> {
  const { files } = await bpFetch<{ files: Record<string, any>[] }>("/v1/files", {
    botId,
    query: { limit: 100, "tags[source]": "knowledge-base" } as any,
  });
  return files ?? [];
}
