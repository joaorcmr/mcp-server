import { z } from "zod";
import { summarizeContent } from "../botpress/content.js";
import { resolveBotId } from "../config/env.js";
import {
  getBot,
  getBotContent,
  listKnowledgeBaseFiles,
} from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  botId: botIdSchema,
  includeKbFiles: z
    .boolean()
    .optional()
    .default(false)
    .describe("Lista também os arquivos indexados nas knowledge bases e seu status de indexação."),
  refresh: z
    .boolean()
    .optional()
    .default(false)
    .describe("Ignora o cache e baixa o conteúdo do bot novamente."),
};

export const getBotOverviewTool: ToolDefinition = {
  name: "get_bot_overview",
  title: "Panorama do conteúdo de um bot",
  description:
    "Mapa do conteúdo DEPLOYADO de um bot: settings (idioma, modelos, limites), lista de fluxos " +
    "com contagem de nós, knowledge bases, hooks, code actions, tables e variáveis. " +
    "É o ponto de partida antes de usar grep_bot_content, dump_flow ou flow_route_map. " +
    "Atenção: reflete a última PUBLICAÇÃO, não o rascunho atual do Studio.",
  inputSchema,
  handler: safeHandler(async ({ botId, includeKbFiles = false, refresh = false }) => {
    const id = resolveBotId(botId);
    const [bot, content] = await Promise.all([getBot(id), getBotContent(id, { refresh })]);

    const lines: string[] = [];
    lines.push(`# ${bot.name}`);
    lines.push(`  id: ${id}`);
    lines.push(
      `  último deploy: ${bot.deployedAt?.slice(0, 19).replace("T", " ") ?? "nunca"}`,
    );
    lines.push(
      `  última alteração: ${bot.updatedAt?.slice(0, 19).replace("T", " ") ?? "?"}`,
    );
    lines.push(
      "\n⚠️  Este conteúdo é o da última publicação. Alterações salvas no Studio e ainda\n" +
        "   não publicadas NÃO aparecem aqui.\n",
    );

    lines.push(summarizeContent(content));

    if (includeKbFiles) {
      const files = await listKnowledgeBaseFiles(id);
      lines.push(`\n## Arquivos indexados nas KBs (${files.length})`);
      for (const file of files) {
        const tags = (file.tags ?? {}) as Record<string, string>;
        lines.push(
          `  ${file.id}  kb=${tags.kbId ?? "?"}  ${tags.title ?? file.key}  [${file.status ?? "?"}]`,
        );
      }
      lines.push(
        "\n⚠️  Esses arquivos são graváveis pela Files API, mas servem o bot JÁ PUBLICADO —\n" +
          "   sobrescrever muda o comportamento na hora. Equivale a publicar.",
      );
    }

    return lines.join("\n");
  }),
};
