import { z } from "zod";
import { upsertKnowledgeBaseDocument } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const upsertKbDocumentTool: ToolDefinition = {
  name: "upsert_kb_document",
  title: "Criar/atualizar documento numa knowledge base",
  description:
    "Cria ou SUBSTITUI um documento numa knowledge base via Files API (uploadFile) — o " +
    "espelho de escrita da search_knowledge_base. Por baixo, um documento de KB é um " +
    "arquivo com tags `source: knowledge-base`, `kbId` e `title`, indexado no vector " +
    "storage; esta tool cuida das tags e da indexação (index: true). Aceita o id ao vivo " +
    "(kb_01...) ou o legado (kb-...). ATENÇÃO: mesma `key` = sobrescreve o documento " +
    "existente (upsert); para um documento novo use uma key/título novos. A indexação é " +
    "assíncrona — aguarde alguns instantes antes de validar com search_knowledge_base.",
  inputSchema: {
    knowledgeBaseId: z
      .string()
      .min(1)
      .describe("KB de destino. Aceita o id ao vivo (kb_01...) ou o legado (kb-...)."),
    title: z
      .string()
      .min(1)
      .describe(
        "Título do documento como aparece no Studio, ex.: '15. Rejeições de Cupom Fiscal v1.0.md'.",
      ),
    content: z
      .string()
      .min(1)
      .describe("Conteúdo completo do documento (markdown recomendado)."),
    key: z
      .string()
      .optional()
      .describe(
        "Opcional: key única do arquivo. Padrão: '<kbTagId>/<title>'. Reusar uma key existente sobrescreve o documento.",
      ),
    contentType: z
      .string()
      .optional()
      .describe("Opcional: MIME type do conteúdo. Padrão: text/markdown."),
    tags: z
      .record(z.string())
      .optional()
      .describe(
        "Opcional: tags extras a preservar (ex.: dsId/dsType de docs rich-text do Studio). " +
          "O upload SUBSTITUI as tags — ao sobrescrever um doc existente, repasse as tags " +
          "originais obtidas via get_kb_document.",
      ),
  },
  handler: async ({ knowledgeBaseId, title, content, key, contentType, tags }) => {
    try {
      const result = await upsertKnowledgeBaseDocument({
        knowledgeBaseId,
        title,
        content,
        key,
        contentType,
        tags,
      });
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
