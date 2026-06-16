import { z } from "zod";
import { sendMessageToBot } from "../botpress/botpress-client.js";
import { formatBotpressError } from "../botpress/errors.js";

/**
 * Forma de uma tool MCP neste projeto. Cada tool exporta um objeto com
 * nome, descrição, schema de entrada (zod) e handler. O `index.ts` registra
 * todas as tools deste formato no servidor.
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

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
