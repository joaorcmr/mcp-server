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
