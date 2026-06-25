import { z } from "zod";
import { searchKnowledgeBase } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const searchKnowledgeBaseTool: ToolDefinition = {
  name: "search_knowledge_base",
  title: "Buscar conteúdo nas knowledge bases",
  description:
    "Busca semântica (RAG) sobre o CONTEÚDO dos documentos das knowledge bases e retorna os " +
    "trechos mais relevantes para a query — é o mesmo retrieval que o bot usa em runtime. " +
    "Diferente de list_knowledge_bases (que só lista as KBs), esta tool LÊ o texto indexado, " +
    "permitindo validar se uma informação realmente consta numa KB e como está redigida " +
    "(ex.: confirmar a regra de saldo compartilhado de um plano familiar). Sem knowledgeBaseId " +
    "busca em todas as KBs; com ele restringe a uma (aceita o id ao vivo kb_01... ou o legado kb-...).",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe("Pergunta/termo a buscar no conteúdo das KBs, ex.: 'saldo é compartilhado entre titular e dependentes?'."),
    knowledgeBaseId: z
      .string()
      .optional()
      .describe("Opcional: restringe a uma KB. Aceita o id ao vivo (kb_01...) ou o legado (kb-...)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("Máx. de trechos retornados (padrão da API; recomendado 5-8)."),
    withContext: z
      .boolean()
      .optional()
      .describe("Se true, inclui trechos vizinhos (contexto ao redor do match)."),
    contextDepth: z
      .number()
      .int()
      .positive()
      .max(5)
      .optional()
      .describe("Quantidade de trechos vizinhos a incluir quando withContext=true."),
  },
  handler: async ({ query, knowledgeBaseId, limit, withContext, contextDepth }) => {
    try {
      const result = await searchKnowledgeBase({
        query,
        knowledgeBaseId,
        limit,
        withContext,
        contextDepth,
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
