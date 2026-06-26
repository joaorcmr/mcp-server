import { Client } from "@botpress/client";
import { getManagementConfig } from "../config/env.js";

/**
 * Camada de acesso à Management/Runtime API do Botpress (@botpress/client).
 *
 * Diferente da Chat API (que conversa com o bot), esta API GERENCIA recursos
 * do bot: workflows (execuções), tabelas, KBs, etc. Autentica via PAT.
 *
 * IMPORTANTE: o recurso "Workflow" aqui é uma EXECUÇÃO (instância em runtime)
 * de um workflow — tem status/input/output. Não é o desenho do fluxo (que só
 * é editável no Studio/CLI de desenvolvimento).
 */

export type WorkflowStatus =
  | "pending"
  | "in_progress"
  | "failed"
  | "completed"
  | "listening"
  | "paused"
  | "timedout"
  | "cancelled";

/** Subconjunto de status válidos ao CRIAR uma execução de workflow. */
export type CreateWorkflowStatus = "pending" | "in_progress" | "listening";

let client: Client | null = null;

export function getManagementClient(): Client {
  if (!client) {
    const { token, botId, workspaceId, apiUrl } = getManagementConfig();
    client = new Client({ token, botId, workspaceId, apiUrl });
  }
  return client;
}

/** Visão normalizada de uma execução de workflow para as tools. */
export interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  conversationId?: string;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

function toSummary(wf: {
  id: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  conversationId?: string;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  failureReason?: string;
}): WorkflowSummary {
  return {
    id: wf.id,
    name: wf.name,
    status: wf.status,
    input: wf.input,
    output: wf.output,
    conversationId: wf.conversationId,
    userId: wf.userId,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
    completedAt: wf.completedAt,
    failureReason: wf.failureReason,
  };
}

/** READ: lista execuções de workflow, com filtros opcionais. */
export async function listWorkflows(filters: {
  name?: string;
  conversationId?: string;
  userId?: string;
  statuses?: WorkflowStatus[];
  pageSize?: number;
}): Promise<WorkflowSummary[]> {
  const res = await getManagementClient().listWorkflows({
    name: filters.name,
    conversationId: filters.conversationId,
    userId: filters.userId,
    statuses: filters.statuses,
    pageSize: filters.pageSize,
  });
  return res.workflows.map(toSummary);
}

/** READ: busca uma execução de workflow pelo id. */
export async function getWorkflow(id: string): Promise<WorkflowSummary> {
  const res = await getManagementClient().getWorkflow({ id });
  return toSummary(res.workflow);
}

/** Visão normalizada de uma tabela. */
export interface TableSummary {
  id: string;
  name: string;
  factor?: number;
  frozen?: boolean;
}

/** READ: lista as tabelas do bot. */
export async function listTables(): Promise<TableSummary[]> {
  const res = await getManagementClient().listTables({});
  return res.tables.map((t) => ({
    id: t.id,
    name: t.name,
    factor: t.factor,
    frozen: t.frozen,
  }));
}

/** Schema (colunas) de uma tabela. */
export interface TableSchema {
  id: string;
  name: string;
  columns: { name: string; type?: string; nullable?: boolean }[];
}

/** READ: schema/colunas de uma tabela (id ou nome). */
export async function getTable(table: string): Promise<TableSchema> {
  const res = await getManagementClient().getTable({ table });
  const props = (res.table.schema?.properties ?? {}) as Record<
    string,
    { type?: string; "x-nullable"?: boolean; nullable?: boolean }
  >;
  return {
    id: res.table.id,
    name: res.table.name,
    columns: Object.entries(props).map(([name, def]) => ({
      name,
      type: def?.type,
      nullable: def?.nullable ?? def?.["x-nullable"],
    })),
  };
}

export interface FindTableRowsOptions {
  table: string;
  limit?: number;
  offset?: number;
  /** filtro estilo mongodb, ex.: { "AgenteProcessoCompraContador": { "$gte": 3 } } */
  filter?: Record<string, unknown>;
  /** agregação por coluna, ex.: { "intentId": "key", "phraseId": ["count"] } */
  group?: Record<string, unknown>;
  /** colunas a retornar (system columns sempre incluídas). */
  select?: string[];
  orderBy?: string;
  orderDirection?: "asc" | "desc";
}

/** READ: lê/consulta linhas de uma tabela (com filtro, agregação e paginação). */
export async function findTableRows(options: FindTableRowsOptions): Promise<{
  rows: unknown[];
  count: number;
}> {
  const { table, ...body } = options;
  const res = await getManagementClient().findTableRows({ table, ...body });
  return { rows: res.rows ?? [], count: res.rows?.length ?? 0 };
}

/** Visão normalizada de uma knowledge base. */
export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  createdAt?: string;
  tags?: Record<string, string>;
}

/** READ: lista as knowledge bases do bot. */
export async function listKnowledgeBases(): Promise<KnowledgeBaseSummary[]> {
  const res = await getManagementClient().listKnowledgeBases({});
  return res.knowledgeBases.map((k) => ({
    id: k.id,
    name: k.name,
    createdAt: k.createdAt,
    tags: k.tags,
  }));
}

/**
 * Resolve o id de uma KB para o valor que aparece na tag `kbId` dos arquivos.
 *
 * Por baixo, uma KB é um conjunto de arquivos (Files API) com a tag
 * `source: "knowledge-base"` e `kbId: <id>`. Para KBs migradas, esse `kbId` é o
 * id LEGADO (`kb-...`, exposto como `oldKbId` em listKnowledgeBases), não o id ao
 * vivo (`kb_01...`). Aqui aceitamos qualquer um dos dois e devolvemos o que casa
 * com a tag dos arquivos. Filtrar pela tag-key do id ao vivo não é possível: a
 * API rejeita chaves com maiúsculas/underscore.
 */
async function resolveKbTagId(knowledgeBaseId: string): Promise<string> {
  if (knowledgeBaseId.startsWith("kb-")) return knowledgeBaseId;
  const kbs = await listKnowledgeBases();
  const oldId = kbs.find((k) => k.id === knowledgeBaseId)?.tags?.oldKbId;
  return oldId && oldId.length > 0 ? oldId : knowledgeBaseId;
}

/** Um trecho (passage) de um documento de KB retornado pela busca semântica. */
export interface KnowledgeBasePassage {
  /** Texto do trecho (com contexto ao redor, quando aplicável). */
  content: string;
  /** Similaridade com a query (quanto maior, mais relevante). */
  score: number;
  /** Valor da tag kbId do arquivo de origem (id legado para KBs migradas). */
  kbId?: string;
  /** Título/nome do documento de origem. */
  title?: string;
  fileId: string;
  fileKey?: string;
  /** Tipo do trecho: chunk, summary, consolidated, image. */
  passageType?: string;
  pageNumber?: number;
  position?: number;
}

/**
 * READ: busca semântica (RAG) sobre o CONTEÚDO dos documentos das knowledge bases.
 *
 * Diferente de listKnowledgeBases (que só lista as KBs), esta função LÊ o texto
 * indexado e devolve os trechos mais relevantes para a query — o mesmo retrieval
 * que o bot usa em runtime. Use para validar se uma informação realmente consta
 * (e como está redigida) numa KB. Sem `knowledgeBaseId`, busca em todas as KBs;
 * com ele, restringe àquela KB (aceita o id ao vivo `kb_01...` ou o legado `kb-...`).
 */
export async function searchKnowledgeBase(args: {
  query: string;
  knowledgeBaseId?: string;
  limit?: number;
  contextDepth?: number;
  withContext?: boolean;
}): Promise<{ passages: KnowledgeBasePassage[]; count: number; kbTagId?: string }> {
  const tags: Record<string, string> = { source: "knowledge-base" };
  let kbTagId: string | undefined;
  if (args.knowledgeBaseId) {
    kbTagId = await resolveKbTagId(args.knowledgeBaseId);
    tags.kbId = kbTagId;
  }
  const res = await getManagementClient().searchFiles({
    query: args.query,
    tags,
    limit: args.limit,
    contextDepth: args.contextDepth,
    withContext: args.withContext,
  });
  const passages: KnowledgeBasePassage[] = res.passages.map((p) => ({
    content: p.content,
    score: p.score,
    kbId: p.file.tags?.kbId,
    title: p.file.tags?.title,
    fileId: p.file.id,
    fileKey: p.file.key,
    passageType: p.meta?.type,
    pageNumber: p.meta?.pageNumber,
    position: p.meta?.position,
  }));
  return { passages, count: passages.length, kbTagId };
}

/** Extrai o texto de uma payload de mensagem do Botpress, quando do tipo "text". */
function extractText(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

/** Visão normalizada de uma conversa (Runtime API). */
export interface ConversationSummary {
  id: string;
  channel?: string;
  integration?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: Record<string, string>;
}

/**
 * READ: lista conversas do bot (mais recentes primeiro por padrão), com filtro
 * por tags, canal, participantes e período. Use `tags` para localizar a conversa
 * de um número de WhatsApp (o telefone costuma viver em uma tag, não em query
 * direta). Paginação via `nextToken`.
 */
export async function listConversations(filters: {
  tags?: Record<string, string>;
  participantIds?: string[];
  channel?: string;
  integrationName?: string;
  afterDate?: string;
  beforeDate?: string;
  sortField?: "createdAt" | "updatedAt";
  sortDirection?: "asc" | "desc";
  pageSize?: number;
  nextToken?: string;
}): Promise<{ conversations: ConversationSummary[]; nextToken?: string }> {
  const res = await getManagementClient().listConversations({
    tags: filters.tags,
    participantIds: filters.participantIds,
    channel: filters.channel,
    integrationName: filters.integrationName,
    afterDate: filters.afterDate,
    beforeDate: filters.beforeDate,
    sortField: filters.sortField,
    sortDirection: filters.sortDirection,
    pageSize: filters.pageSize,
    nextToken: filters.nextToken,
  });
  return {
    conversations: res.conversations.map((c) => ({
      id: c.id,
      channel: c.channel,
      integration: c.integration,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      tags: c.tags,
    })),
    nextToken: res.meta?.nextToken,
  };
}

/** Visão normalizada de uma mensagem (Runtime API). */
export interface MessageSummary {
  id: string;
  createdAt?: string;
  type?: string;
  direction?: "incoming" | "outgoing";
  /** texto extraído quando a payload é do tipo "text". */
  text?: string;
  payload?: unknown;
  userId?: string;
  conversationId?: string;
  tags?: Record<string, string>;
}

/**
 * READ: lista o histórico de mensagens, normalmente filtrado por `conversationId`.
 * Suporta filtro por período (afterDate/beforeDate ISO 8601) e tags, com paginação
 * via `nextToken`.
 */
export async function listMessages(filters: {
  conversationId?: string;
  tags?: Record<string, string>;
  afterDate?: string;
  beforeDate?: string;
  pageSize?: number;
  nextToken?: string;
}): Promise<{ messages: MessageSummary[]; nextToken?: string }> {
  const res = await getManagementClient().listMessages({
    conversationId: filters.conversationId,
    tags: filters.tags,
    afterDate: filters.afterDate,
    beforeDate: filters.beforeDate,
    pageSize: filters.pageSize,
    nextToken: filters.nextToken,
  });
  return {
    messages: res.messages.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      type: m.type,
      direction: m.direction,
      text: extractText(m.payload),
      payload: m.payload,
      userId: m.userId,
      conversationId: m.conversationId,
      tags: m.tags,
    })),
    nextToken: res.meta?.nextToken,
  };
}

/** Uma entrada de log do bot (Admin API getBotLogs). */
export interface BotLogEntry {
  timestamp: string;
  level: string;
  message: string;
  workflowId?: string;
  userId?: string;
  conversationId?: string;
}

/**
 * READ: lê os logs do bot (Admin API getBotLogs), filtrados por período
 * (timeStart é obrigatório) e, opcionalmente, por nível, usuário, workflow,
 * conversa ou trecho da mensagem. Paginação via nextToken. Útil para diagnosticar
 * por que uma conversa parou (ex.: erro de execução, HITL não liberado).
 */
export async function getBotLogs(filters: {
  timeStart: string;
  timeEnd?: string;
  level?: string;
  userId?: string;
  workflowId?: string;
  conversationId?: string;
  messageContains?: string;
  nextToken?: string;
}): Promise<{ logs: BotLogEntry[]; nextToken?: string }> {
  const { botId } = getManagementConfig();
  const res = await getManagementClient().getBotLogs({
    id: botId,
    timeStart: filters.timeStart,
    timeEnd: filters.timeEnd,
    level: filters.level,
    userId: filters.userId,
    workflowId: filters.workflowId,
    conversationId: filters.conversationId,
    messageContains: filters.messageContains,
    nextToken: filters.nextToken,
  });
  return { logs: res.logs, nextToken: res.nextToken };
}

/**
 * Um bucket (geralmente diário) das métricas agregadas do bot, como aparecem
 * no painel de Analytics do Botpress. Espelha o `GetBotAnalyticsResponse` do
 * @botpress/client. Campos de volume/usuários/sessões + uso de LLM (custo/tokens).
 */
export interface BotAnalyticsRecord {
  /** Início (inclusive) do período deste bucket (ISO 8601). */
  startDateTimeUtc: string;
  /** Fim (inclusive) do período deste bucket (ISO 8601). */
  endDateTimeUtc: string;
  returningUsers: number;
  newUsers: number;
  sessions: number;
  /** Depreciado pelo Botpress: use `userMessages`. */
  messages: number;
  userMessages: number;
  botMessages: number;
  events: number;
  /** Contagem de eventos por tipo. */
  eventTypes: Record<string, number>;
  /** Contagem de eventos customizados (emitidos pelo bot). */
  customEvents: Record<string, number>;
  /** Uso de LLM: chamadas, erros, tokens, latência (ms), velocidade e custo (USD). */
  llm: {
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    latency: { mean: number; sd: number; min: number; max: number };
    tokensPerSecond: { mean: number; sd: number; min: number; max: number };
    cost: { sum: number; mean: number; sd: number; min: number; max: number };
  };
}

/**
 * READ: métricas agregadas do bot (Admin API getBotAnalytics) — a mesma fonte do
 * painel de Analytics. Retorna uma lista de buckets (normalmente um por dia) no
 * período [startDate, endDate] (ambos ISO 8601, obrigatórios), com volume de
 * mensagens, usuários novos/recorrentes, sessões, eventos e uso/custo de LLM.
 */
export async function getBotAnalytics(filters: {
  startDate: string;
  endDate: string;
}): Promise<{ records: BotAnalyticsRecord[] }> {
  const { botId } = getManagementConfig();
  const res = await getManagementClient().getBotAnalytics({
    id: botId,
    startDate: filters.startDate,
    endDate: filters.endDate,
  });
  return { records: res.records as BotAnalyticsRecord[] };
}

/** Tipos de recurso aos quais um State pode estar vinculado. */
export type StateType = "conversation" | "user" | "bot" | "integration" | "workflow";

/** Visão normalizada de um State (payload + expiry). */
export interface StateSummary {
  id: string;
  type?: string;
  name?: string;
  payload?: unknown;
}

/**
 * READ: lê o State (payload) de um recurso. Útil ANTES de patch/set para saber
 * o nome e o conteúdo atual do state (ex.: o state de HITL de uma conversa).
 */
export async function getState(args: {
  type: StateType;
  id: string;
  name: string;
}): Promise<StateSummary> {
  const res = await getManagementClient().getState({
    type: args.type,
    id: args.id,
    name: args.name,
  });
  return {
    id: res.state.id,
    type: (res.state as { type?: string }).type,
    name: (res.state as { name?: string }).name,
    payload: res.state.payload,
  };
}

/**
 * WRITE: SOBRESCREVE por completo o payload de um State (POST /v1/chat/states/...).
 * Substitui o payload anterior — campos não enviados são DESCARTADOS. Aceita um
 * `expiry` opcional (TTL ocioso em ms, máx. 30 dias / 2592000000). Use patchState
 * para mesclar em vez de sobrescrever.
 */
export async function setState(args: {
  type: StateType;
  id: string;
  name: string;
  payload: Record<string, unknown> | null;
  expiry?: number | null;
}): Promise<StateSummary> {
  const res = await getManagementClient().setState({
    type: args.type,
    id: args.id,
    name: args.name,
    payload: args.payload,
    expiry: args.expiry,
  });
  return {
    id: res.state.id,
    type: (res.state as { type?: string }).type,
    name: (res.state as { name?: string }).name,
    payload: res.state.payload,
  };
}

/**
 * WRITE: MESCLA valores no payload de um State (PATCH /v1/chat/states/...).
 * Campos não enviados são PRESERVADOS. Aceita `expiry` opcional (ms, máx. 30 dias).
 */
export async function patchState(args: {
  type: StateType;
  id: string;
  name: string;
  payload: Record<string, unknown>;
  expiry?: number | null;
}): Promise<StateSummary> {
  const res = await getManagementClient().patchState({
    type: args.type,
    id: args.id,
    name: args.name,
    payload: args.payload,
    expiry: args.expiry,
  });
  return {
    id: res.state.id,
    type: (res.state as { type?: string }).type,
    name: (res.state as { name?: string }).name,
    payload: res.state.payload,
  };
}

/**
 * WRITE (DESTRUTIVO): apaga uma conversa pelo id (DELETE /v1/chat/conversations/{id}).
 * Remove a conversa e suas mensagens. Operação irreversível.
 */
export async function deleteConversation(id: string): Promise<{ id: string; deleted: true }> {
  await getManagementClient().deleteConversation({ id });
  return { id, deleted: true };
}

/**
 * Nome do state (namespaced pelo plugin `hitl`) que controla a pausa do bot
 * durante um handoff humano. Payload: `{ hitlActive: boolean }`. Enquanto
 * `hitlActive` for `true`, o bot ignora as mensagens do usuário e as repassa ao
 * atendente; ao virar `false`, o bot volta a responder.
 */
export const HITL_STATE_NAME = "hitl#hitl";

/**
 * WRITE: libera uma conversa presa em HITL, virando `hitlActive` para `false` no
 * state `hitl#hitl` (atalho semântico sobre patch_state). Lê o valor anterior para
 * relatório. ATENÇÃO: é um flip cirúrgico do state — NÃO executa o fluxo normal de
 * stopHitl, então o lado do atendente (ex.: ticket Zendesk) não é fechado e a
 * mensagem onHitlStoppedMessage pode não ser enviada. Apenas despausa o bot.
 */
export async function releaseHitl(conversationId: string): Promise<{
  conversationId: string;
  previousHitlActive?: boolean;
  hitlActive: boolean;
  alreadyReleased: boolean;
}> {
  const client = getManagementClient();
  let previousHitlActive: boolean | undefined;
  try {
    const before = await client.getState({
      type: "conversation",
      id: conversationId,
      name: HITL_STATE_NAME,
    });
    const p = before.state.payload as { hitlActive?: boolean } | null;
    previousHitlActive = p?.hitlActive;
  } catch {
    // Se o state ainda não existe, seguimos e o patch o cria com hitlActive:false.
  }
  if (previousHitlActive === false) {
    return { conversationId, previousHitlActive, hitlActive: false, alreadyReleased: true };
  }
  const res = await client.patchState({
    type: "conversation",
    id: conversationId,
    name: HITL_STATE_NAME,
    payload: { hitlActive: false },
  });
  const after = res.state.payload as { hitlActive?: boolean } | null;
  return {
    conversationId,
    previousHitlActive,
    hitlActive: after?.hitlActive ?? false,
    alreadyReleased: false,
  };
}

/** WRITE: inicia uma nova execução de workflow pelo nome definido no bot. */
export async function startWorkflow(args: {
  name: string;
  status?: CreateWorkflowStatus;
  input?: Record<string, unknown>;
  conversationId?: string;
  userId?: string;
}): Promise<WorkflowSummary> {
  const res = await getManagementClient().createWorkflow({
    name: args.name,
    status: args.status ?? "pending",
    input: args.input,
    conversationId: args.conversationId,
    userId: args.userId,
  });
  return toSummary(res.workflow);
}
