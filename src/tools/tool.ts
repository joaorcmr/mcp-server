import { z } from "zod";
import { formatBotpressError } from "../botpress/errors.js";

/**
 * Forma de uma tool MCP neste projeto. Cada tool exporta um objeto com nome,
 * descrição, schema de entrada (zod) e handler. O `index.ts` registra todas.
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

/** Resposta de texto simples. */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Embrulha o handler para que qualquer erro vire uma resposta legível em vez de
 * uma exceção de protocolo — o cliente MCP consegue mostrar a causa ao usuário.
 */
export function safeHandler(
  handler: (args: any) => Promise<string>,
): ToolDefinition["handler"] {
  return async (args: any) => {
    try {
      return textResult(await handler(args));
    } catch (err) {
      const formatted = formatBotpressError(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(formatted, null, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

/** Campo `botId` reutilizado pelas tools com escopo de bot. */
export const botIdSchema = z
  .string()
  .optional()
  .describe(
    "ID do bot. Se omitido, usa BOTPRESS_BOT_ID do .env. Use list_bots para descobrir os IDs.",
  );
