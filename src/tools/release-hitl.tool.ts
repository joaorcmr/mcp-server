import { z } from "zod";
import { releaseHitl } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const releaseHitlTool: ToolDefinition = {
  name: "release_hitl",
  title: "Liberar conversa presa em HITL",
  description:
    "WRITE: despausa o bot em uma conversa presa em handoff humano (HITL), virando " +
    "`hitlActive` para false no state `hitl#hitl` da conversa. Atalho semântico sobre patch_state, " +
    "usado quando o ticket externo (ex.: Zendesk) nunca foi fechado e o bot parou de responder o " +
    "usuário. ATENÇÃO: é um flip cirúrgico do state — NÃO executa o fluxo normal de stopHitl, então " +
    "o ticket do atendente NÃO é fechado e a mensagem onHitlStoppedMessage pode não ser enviada; " +
    "apenas faz o bot voltar a responder o usuário. Obtenha o conversationId via list_conversations " +
    '(tag whatsapp:userPhone, ex.: "+5511981063002").',
  inputSchema: {
    conversationId: z
      .string()
      .describe("Id da conversa a liberar do HITL (ex.: conv_...)."),
  },
  handler: async (args) => {
    try {
      const result = await releaseHitl(args.conversationId);
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
