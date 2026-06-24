import { z } from "zod";
import { setState } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const setStateTool: ToolDefinition = {
  name: "set_state",
  title: "Sobrescrever State (override)",
  description:
    "WRITE: SOBRESCREVE por completo o payload de um State (POST /v1/chat/states/{type}/{id}/{name}). " +
    "Substitui o payload anterior — campos NÃO enviados são DESCARTADOS. Para apenas mesclar alguns " +
    "campos, use patch_state. type é um de: conversation, user, bot, integration, workflow. expiry é " +
    "opcional (TTL ocioso em ms, máx. 30 dias / 2592000000). Dica: rode get_state antes para não perder dados.",
  inputSchema: {
    type: z
      .enum(["conversation", "user", "bot", "integration", "workflow"])
      .describe("Tipo do recurso ao qual o state está vinculado."),
    id: z.string().describe("Id do recurso (conversationId/userId/botId conforme o type)."),
    name: z.string().describe("Nome do state declarado na definição do bot."),
    payload: z
      .record(z.any())
      .nullable()
      .describe("Novo payload COMPLETO do state (substitui o anterior). Use null para esvaziar."),
    expiry: z
      .number()
      .int()
      .positive()
      .max(2592000000)
      .nullable()
      .optional()
      .describe("TTL ocioso em ms (máx. 2592000000 = 30 dias). Omita para nunca expirar."),
  },
  handler: async (args) => {
    try {
      const state = await setState(args);
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
