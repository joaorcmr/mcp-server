import { z } from "zod";
import { listConversations } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const listConversationsTool: ToolDefinition = {
  name: "list_conversations",
  title: "Listar conversas do bot",
  description:
    "Lista as conversas do bot (mais recentes primeiro por padrão), com filtro por tags, canal, " +
    "participantes e período (afterDate/beforeDate em ISO 8601). Use para descobrir o conversationId " +
    "antes de ler o histórico com list_messages. O telefone de um número de WhatsApp normalmente vive " +
    "numa TAG da conversa (ex.: tags { 'whatsapp:userPhone': '5511981063002' }), não em query direta. " +
    "Paginação via nextToken.",
  inputSchema: {
    tags: z
      .record(z.string())
      .optional()
      .describe('Filtro por tags, ex.: { "whatsapp:userPhone": "5511981063002" }.'),
    participantIds: z.array(z.string()).optional().describe("Filtra por ids de participantes (usuários)."),
    channel: z.string().optional().describe("Filtra por canal (ex.: whatsapp)."),
    integrationName: z.string().optional().describe("Filtra pelo nome da integração que criou a conversa."),
    afterDate: z.string().optional().describe("Apenas conversas a partir desta data (ISO 8601)."),
    beforeDate: z.string().optional().describe("Apenas conversas até esta data (ISO 8601)."),
    sortField: z.enum(["createdAt", "updatedAt"]).optional().describe("Campo de ordenação."),
    sortDirection: z.enum(["asc", "desc"]).optional().describe("Direção da ordenação (padrão: mais recente primeiro)."),
    pageSize: z.number().int().positive().max(100).optional().describe("Tamanho da página."),
    nextToken: z.string().optional().describe("Token para a próxima página (paginação)."),
  },
  handler: async (args) => {
    try {
      const { conversations, nextToken } = await listConversations(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, count: conversations.length, conversations, nextToken },
              null,
              2,
            ),
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
