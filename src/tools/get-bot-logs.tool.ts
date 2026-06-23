import { z } from "zod";
import { getBotLogs } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const getBotLogsTool: ToolDefinition = {
  name: "get_bot_logs",
  title: "Buscar logs do bot",
  description:
    "Lê os logs de execução do bot (Admin API getBotLogs). timeStart é OBRIGATÓRIO (ISO 8601). " +
    "Filtros opcionais: timeEnd, level (ex.: 'error'), userId, workflowId, conversationId e " +
    "messageContains (trecho da mensagem de log). Paginação via nextToken. Útil para diagnosticar " +
    "por que uma conversa parou de responder (ex.: erro de execução, HITL não liberado).",
  inputSchema: {
    timeStart: z.string().describe("Início do período (ISO 8601). OBRIGATÓRIO."),
    timeEnd: z.string().optional().describe("Fim do período (ISO 8601)."),
    level: z.string().optional().describe("Filtra por nível do log (ex.: 'error', 'info', 'warn')."),
    userId: z.string().optional().describe("Filtra por id de usuário."),
    workflowId: z.string().optional().describe("Filtra por id de execução de workflow."),
    conversationId: z.string().optional().describe("Filtra pelos logs de uma conversa específica."),
    messageContains: z.string().optional().describe("Filtra logs cuja mensagem contém este trecho."),
    nextToken: z.string().optional().describe("Token para a próxima página (paginação)."),
  },
  handler: async (args) => {
    try {
      const { logs, nextToken } = await getBotLogs(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, count: logs.length, logs, nextToken }, null, 2),
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
