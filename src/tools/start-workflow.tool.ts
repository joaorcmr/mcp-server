import { z } from "zod";
import { startWorkflow } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe("Nome do workflow definido no bot a ser iniciado (ex.: o 'Support Omni')."),
  status: z
    .enum(["pending", "in_progress", "listening"])
    .optional()
    .describe("Status inicial da execução. Padrão: 'pending'."),
  input: z
    .record(z.any())
    .optional()
    .describe("Objeto de entrada passado ao workflow (input variables)."),
  conversationId: z
    .string()
    .optional()
    .describe("Conversa à qual amarrar a execução, se aplicável."),
  userId: z.string().optional().describe("Usuário ao qual amarrar a execução, se aplicável."),
};

export const startWorkflowTool: ToolDefinition = {
  name: "start_workflow",
  title: "Iniciar execução de workflow",
  description:
    "Inicia uma nova EXECUÇÃO de um workflow do bot no Botpress, pelo nome. Cria uma " +
    "instância em runtime (não altera o desenho do fluxo). Retorna a execução criada " +
    "com id e status.",
  inputSchema,
  handler: async ({ name, status, input, conversationId, userId }) => {
    try {
      const workflow = await startWorkflow({ name, status, input, conversationId, userId });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, workflow }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
