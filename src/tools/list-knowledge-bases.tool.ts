import { listKnowledgeBases } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const listKnowledgeBasesTool: ToolDefinition = {
  name: "list_knowledge_bases",
  title: "Listar knowledge bases do bot",
  description:
    "Lista as knowledge bases (KBs) do bot, com id, nome e tags. Útil para mapear os " +
    "tópicos de RAG do bot e cruzar com o que aparece nos flows/diagramas. Atenção: os " +
    "ids ao vivo (kb_01...) diferem dos ids internos do export (kb-...).",
  inputSchema: {},
  handler: async () => {
    try {
      const knowledgeBases = await listKnowledgeBases();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, count: knowledgeBases.length, knowledgeBases },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
