import { z } from "zod";
import { grepContent } from "../botpress/content.js";
import { resolveBotId } from "../config/env.js";
import { getBotContent } from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  pattern: z
    .string()
    .min(1)
    .describe(
      "Expressão regular (JavaScript, case-insensitive). Ex.: '\\\\b45\\\\s*dias', 'homeop[áa]tic', 'tags\\\\?\\\\.downstream'.",
    ),
  botId: botIdSchema,
  sections: z
    .array(z.enum(["flows", "knowledge_base", "hooks", "actions", "settings", "tables"]))
    .optional()
    .describe("Restringe a busca a certas seções. Se omitido, busca em tudo."),
  context: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .default(160)
    .describe("Caracteres de contexto ao redor de cada ocorrência."),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(60)
    .describe("Teto de ocorrências retornadas."),
};

export const grepBotContentTool: ToolDefinition = {
  name: "grep_bot_content",
  title: "Buscar texto no conteúdo do bot",
  description:
    "Busca por regex em TODO o conteúdo do bot (guidelines dos agentes, KBs em HTML, código de " +
    "hooks e actions, mensagens, condições de transição) e informa exatamente onde cada " +
    "ocorrência está — fluxo, nó e ID do nó, prontos para localizar no Studio. " +
    "É a principal ferramenta para auditar regras de negócio, já que a lógica deste bot vive " +
    "majoritariamente como texto de prompt.",
  inputSchema,
  handler: safeHandler(
    async ({ pattern, botId, sections, context = 160, maxMatches = 60 }) => {
      const id = resolveBotId(botId);
      const content = await getBotContent(id);
      const { matches, total, truncated } = grepContent(content, pattern, {
        context,
        maxMatches,
        sections,
      });

      if (!total) {
        return `Nenhuma ocorrência de /${pattern}/i no bot ${id}.`;
      }

      const lines: string[] = [];
      lines.push(
        `# ${total} ocorrência(s) de /${pattern}/i` +
          (truncated ? ` (mostrando ${matches.length})` : ""),
      );

      // Agrupa por local: uma guideline com 8 ocorrências é UM lugar para editar.
      const byLocation = new Map<string, typeof matches>();
      for (const match of matches) {
        const bucket = byLocation.get(match.location) ?? [];
        bucket.push(match);
        byLocation.set(match.location, bucket);
      }

      lines.push(`\n## Locais afetados (${byLocation.size})`);
      for (const [location, hits] of byLocation) {
        lines.push(`  ${hits.length}x  ${location}`);
      }

      lines.push("\n## Ocorrências");
      for (const [location, hits] of byLocation) {
        lines.push(`\n### ${location}`);
        lines.push(`    (${hits[0].path})`);
        for (const hit of hits) {
          lines.push(`  • ${hit.snippet}`);
        }
      }

      if (truncated) {
        lines.push(
          `\n[${total - matches.length} ocorrência(s) omitida(s). Aumente maxMatches ou refine o padrão.]`,
        );
      }

      return lines.join("\n");
    },
  ),
};
