import { listTables } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  title: "Listar tabelas do bot",
  description:
    "Lista as tabelas (Botpress Tables) do bot, com id e nome. Útil para descobrir " +
    "tabelas de monitoramento/analytics (ex.: Monitoramento_Agentes_Table) antes de ler linhas.",
  inputSchema: {},
  handler: async () => {
    try {
      const tables = await listTables();
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, count: tables.length, tables }, null, 2) },
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
