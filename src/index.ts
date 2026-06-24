import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ToolDefinition } from "./tools/tool.js";
import { sendMessageToBotpressTool } from "./tools/send-message-to-botpress.tool.js";
import { listWorkflowsTool } from "./tools/list-workflows.tool.js";
import { startWorkflowTool } from "./tools/start-workflow.tool.js";
import { listTablesTool } from "./tools/list-tables.tool.js";
import { listKnowledgeBasesTool } from "./tools/list-knowledge-bases.tool.js";
import { getTableTool } from "./tools/get-table.tool.js";
import { findTableRowsTool } from "./tools/find-table-rows.tool.js";
import { listConversationsTool } from "./tools/list-conversations.tool.js";
import { listMessagesTool } from "./tools/list-messages.tool.js";
import { getBotLogsTool } from "./tools/get-bot-logs.tool.js";
import { getStateTool } from "./tools/get-state.tool.js";
import { setStateTool } from "./tools/set-state.tool.js";
import { patchStateTool } from "./tools/patch-state.tool.js";
import { deleteConversationTool } from "./tools/delete-conversation.tool.js";
import { releaseHitlTool } from "./tools/release-hitl.tool.js";

/**
 * Entrypoint do MCP Server do Botpress.
 *
 * Roda localmente via stdio para ser consumido pelo Claude Code. NUNCA escreva
 * em stdout com console.log: isso corromperia o protocolo JSON-RPC. Use
 * console.error para logs/diagnóstico (vai para stderr).
 */

const server = new McpServer({
  name: "botpress-mcp-server",
  version: "0.1.0",
});

// Registre aqui todas as tools. Para adicionar uma nova, basta criar o arquivo
// em src/tools/ exportando um ToolDefinition e incluí-lo nesta lista.
const tools: ToolDefinition[] = [
  sendMessageToBotpressTool,
  listWorkflowsTool,
  startWorkflowTool,
  listTablesTool,
  listKnowledgeBasesTool,
  getTableTool,
  findTableRowsTool,
  listConversationsTool,
  listMessagesTool,
  getBotLogsTool,
  getStateTool,
  setStateTool,
  patchStateTool,
  deleteConversationTool,
  releaseHitlTool,
];

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    tool.handler,
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[botpress-mcp-server] conectado via stdio. Tools: ${tools.map((t) => t.name).join(", ")}`,
  );
}

main().catch((err) => {
  console.error("[botpress-mcp-server] erro fatal ao iniciar:", err);
  process.exit(1);
});
