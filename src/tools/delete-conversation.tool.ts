import { z } from "zod";
import { deleteConversation } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const deleteConversationTool: ToolDefinition = {
  name: "delete_conversation",
  title: "Apagar conversa",
  description:
    "WRITE (DESTRUTIVO E IRREVERSÍVEL): apaga uma conversa e suas mensagens " +
    "(DELETE /v1/chat/conversations/{id}). Use com cautela — confirme o id antes. " +
    "Apagar a conversa NÃO fecha um ticket de HITL externo (Zendesk); para liberar um " +
    "HITL preso, ajuste o state da conversa via patch_state/set_state.",
  inputSchema: {
    id: z.string().describe("Id da conversa a apagar (ex.: conv_...). Operação irreversível."),
  },
  handler: async (args) => {
    try {
      const result = await deleteConversation(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
