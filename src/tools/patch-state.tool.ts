import { z } from "zod";
import { patchState } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const patchStateTool: ToolDefinition = {
  name: "patch_state",
  title: "Mesclar State (merge)",
  description:
    "WRITE: MESCLA valores no payload de um State (PATCH /v1/chat/states/{type}/{id}/{name}). " +
    "Os campos enviados são mesclados; campos NÃO enviados são PRESERVADOS. Para substituir o " +
    "payload inteiro, use set_state. type é um de: conversation, user, bot, integration, workflow. " +
    "expiry é opcional (TTL ocioso em ms, máx. 30 dias / 2592000000).",
  inputSchema: {
    type: z
      .enum(["conversation", "user", "bot", "integration", "workflow"])
      .describe("Tipo do recurso ao qual o state está vinculado."),
    id: z.string().describe("Id do recurso (conversationId/userId/botId conforme o type)."),
    name: z.string().describe("Nome do state declarado na definição do bot."),
    payload: z
      .record(z.any())
      .describe("Campos a mesclar no payload existente (não substitui o todo)."),
    expiry: z
      .number()
      .int()
      .positive()
      .max(2592000000)
      .nullable()
      .optional()
      .describe("TTL ocioso em ms (máx. 2592000000 = 30 dias). Omita para manter o atual."),
  },
  handler: async (args) => {
    try {
      const state = await patchState(args);
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
