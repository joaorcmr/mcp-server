import { z } from "zod";
import { getTable } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const getTableTool: ToolDefinition = {
  name: "get_table",
  title: "Ver schema de uma tabela",
  description:
    "Retorna o schema (colunas e tipos) de uma tabela do bot. Use antes de find_table_rows " +
    "para saber quais colunas filtrar/selecionar (ex.: colunas de contador do Monitoramento_Agentes_Table).",
  inputSchema: {
    table: z.string().min(1).describe("Id (table_...) ou nome da tabela."),
  },
  handler: async ({ table }) => {
    try {
      const schema = await getTable(table);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...schema }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify(formatBotpressError(err), null, 2) }],
        isError: true,
      };
    }
  },
};
