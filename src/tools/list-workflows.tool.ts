import { z } from "zod";
import { listWorkflows } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

const WORKFLOW_STATUSES = [
  "pending",
  "in_progress",
  "failed",
  "completed",
  "listening",
  "paused",
  "timedout",
  "cancelled",
] as const;

const inputSchema = {
  name: z
    .string()
    .optional()
    .describe("Filtra por nome do workflow (ex.: o nome interno do 'Support Omni')."),
  conversationId: z
    .string()
    .optional()
    .describe("Filtra execuções ligadas a uma conversa específica."),
  userId: z.string().optional().describe("Filtra execuções de um usuário específico."),
  statuses: z
    .array(z.enum(WORKFLOW_STATUSES))
    .optional()
    .describe("Filtra por um ou mais status de execução."),
  pageSize: z.number().int().positive().max(100).optional().describe("Limite de resultados."),
};

export const listWorkflowsTool: ToolDefinition = {
  name: "list_workflows",
  title: "Listar execuções de workflow",
  description:
    "Lista EXECUÇÕES (instâncias em runtime) de workflows do bot no Botpress, com " +
    "status/input/output. Útil para inspecionar o que rodou. Observação: lista " +
    "execuções, não o desenho do fluxo (que vive no Studio).",
  inputSchema,
  handler: async ({ name, conversationId, userId, statuses, pageSize }) => {
    try {
      const workflows = await listWorkflows({ name, conversationId, userId, statuses, pageSize });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, count: workflows.length, workflows }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
