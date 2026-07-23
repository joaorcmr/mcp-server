import { z } from "zod";
import { getKnowledgeBaseDocument } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const getKbDocumentTool: ToolDefinition = {
  name: "get_kb_document",
  title: "Baixar o conteúdo completo de um documento de KB",
  description:
    "Baixa o CONTEÚDO BRUTO completo de um documento de knowledge base via Files API " +
    "(getFile → presigned URL de download). Complementa a search_knowledge_base (que só " +
    "devolve trechos via RAG): use esta tool quando precisar do arquivo inteiro — em " +
    "especial para EDITAR um documento existente sem destruir o restante (ler aqui → " +
    "editar → republicar com upsert_kb_document usando a MESMA key e contentType). " +
    "Aceita o fileId direto (retornado pela busca) ou knowledgeBaseId + title/key para " +
    "localizar o arquivo pelas tags.",
  inputSchema: {
    fileId: z
      .string()
      .optional()
      .describe("Id do arquivo (file_01...), como retornado pela search_knowledge_base."),
    knowledgeBaseId: z
      .string()
      .optional()
      .describe(
        "Alternativa ao fileId: KB do documento. Aceita o id ao vivo (kb_01...) ou o legado (kb-...). Use junto com title ou key.",
      ),
    title: z
      .string()
      .optional()
      .describe("Título do documento (tag title), como aparece no Studio."),
    key: z
      .string()
      .optional()
      .describe("Key exata do arquivo, ex.: 'kb-.../doc.html'."),
  },
  handler: async ({ fileId, knowledgeBaseId, title, key }) => {
    try {
      const result = await getKnowledgeBaseDocument({ fileId, knowledgeBaseId, title, key });
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
