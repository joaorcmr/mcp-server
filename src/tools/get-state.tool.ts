import { z } from "zod";
import { getState } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const getStateTool: ToolDefinition = {
  name: "get_state",
  title: "Ler State de um recurso",
  description:
    "Lê o State (payload atual) de um recurso (GET /v1/chat/states/{type}/{id}/{name}). " +
    "type é um de: conversation, user, bot, integration, workflow. id é o id do recurso " +
    "(conversationId/userId/botId conforme o type) e name é o nome do state declarado na " +
    "definição do bot. Use ANTES de set_state/patch_state para inspecionar o conteúdo atual.",
  inputSchema: {
    type: z
      .enum(["conversation", "user", "bot", "integration", "workflow"])
      .describe("Tipo do recurso ao qual o state está vinculado."),
    id: z.string().describe("Id do recurso (conversationId/userId/botId conforme o type)."),
    name: z.string().describe("Nome do state declarado na definição do bot."),
  },
  handler: async (args) => {
    try {
      const state = await getState(args);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, state }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
