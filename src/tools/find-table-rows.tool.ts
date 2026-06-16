import { z } from "zod";
import { findTableRows } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const findTableRowsTool: ToolDefinition = {
  name: "find_table_rows",
  title: "Ler linhas de uma tabela",
  description:
    "Lê/consulta linhas de uma tabela do bot, com filtro (estilo mongodb), agregação, seleção " +
    "de colunas e paginação. Base para calcular métricas de resolutividade " +
    "(ex.: filter { AgenteProcessoCompraContador: { $gte: 3 } } no Monitoramento_Agentes_Table).",
  inputSchema: {
    table: z.string().min(1).describe("Id (table_...) ou nome da tabela."),
    filter: z
      .record(z.any())
      .optional()
      .describe('Filtro mongodb-like, ex.: { "Resolveu": { "$eq": "nao" } }.'),
    group: z
      .record(z.any())
      .optional()
      .describe('Agregação por coluna, ex.: { "intentId": "key", "phraseId": ["count"] }.'),
    select: z.array(z.string()).optional().describe("Colunas a retornar (system columns sempre vêm)."),
    orderBy: z.string().optional().describe("Coluna de ordenação (padrão: id)."),
    orderDirection: z.enum(["asc", "desc"]).optional().describe("Direção da ordenação."),
    limit: z.number().int().positive().max(1000).optional().describe("Máx. de linhas (padrão da API)."),
    offset: z.number().int().nonnegative().optional().describe("Deslocamento para paginação."),
  },
  handler: async ({ table, filter, group, select, orderBy, orderDirection, limit, offset }) => {
    try {
      const result = await findTableRows({
        table,
        filter,
        group,
        select,
        orderBy,
        orderDirection,
        limit,
        offset,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) },
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
