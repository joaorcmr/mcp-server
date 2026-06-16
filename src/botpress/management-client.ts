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
