import { z } from "zod";
import { listMessages } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const listMessagesTool: ToolDefinition = {
  name: "list_messages",
  title: "Ler histórico de mensagens",
  description:
    "Lê o histórico de mensagens de uma conversa (Runtime API). Normalmente filtrado por " +
    "conversationId (obtido via list_conversations). Cada mensagem traz direction " +
    "('incoming'|'outgoing'), type, payload e o texto extraído quando aplicável. Suporta filtro por " +
    "período (afterDate/beforeDate em ISO 8601) e tags, com paginação via nextToken. Útil para " +
    "inspecionar por que um número não recebe resposta (ex.: conversa parada em HITL).",
  inputSchema: {
    conversationId: z.string().optional().describe("Filtra as mensagens de uma conversa específica."),
    tags: z.record(z.string()).optional().describe('Filtro por tags, ex.: { "whatsapp:userPhone": "5511981063002" }.'),
    afterDate: z.string().optional().describe("Apenas mensagens a partir desta data (ISO 8601)."),
    beforeDate: z.string().optional().describe("Apenas mensagens até esta data (ISO 8601)."),
    pageSize: z.number().int().positive().max(100).optional().describe("Tamanho da página."),
    nextToken: z.string().optional().describe("Token para a próxima página (paginação)."),
  },
  handler: async (args) => {
    try {
      const { messages, nextToken } = await listMessages(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, count: messages.length, messages, nextToken }, null, 2),
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
