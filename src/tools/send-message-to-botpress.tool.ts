import { z } from "zod";
import { sendMessageToBot } from "../botpress/botpress-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

// A definição de ToolDefinition vive em ./tool.ts, compartilhada por todas as tools.
export type { ToolDefinition };

const inputSchema = {
  message: z
    .string()
    .min(1, "message não pode ser vazio")
    .describe("Texto da mensagem a enviar para o bot do Botpress."),
  userId: z
    .string()
    .optional()
    .describe("Identificador opcional do usuário de teste (rótulo informativo)."),
};

export const sendMessageToBotpressTool: ToolDefinition = {
  name: "send_message_to_botpress",
  title: "Enviar mensagem para o Botpress",
  description:
    "Envia uma mensagem de texto para o bot do Botpress (via Chat API), aguarda a(s) " +
    "resposta(s) do bot e retorna a conversa de forma estruturada. Útil para testar " +
    "fluxos, validar respostas e depurar o comportamento do bot.",
  inputSchema,
  handler: async ({ message, userId }) => {
    try {
      const result = await sendMessageToBot({ message, userId });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const formatted = formatBotpressError(err);
      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        isError: true,
      };
    }
  },
};
