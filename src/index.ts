import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { auditAllBotsTool, compareBotsTool } from "./tools/compare-bots.tool.js";
import { getBotCodeTool } from "./tools/get-bot-code.tool.js";
import { getBotOverviewTool } from "./tools/get-bot-overview.tool.js";
import { grepBotContentTool } from "./tools/grep-bot-content.tool.js";
import { inspectFlowTool } from "./tools/inspect-flow.tool.js";
import { inspectHitlTool, listConversationsTool } from "./tools/inspect-hitl.tool.js";
import { listBotsTool } from "./tools/list-bots.tool.js";
import { sendMessageToBotpressTool } from "./tools/send-message-to-botpress.tool.js";
import type { ToolDefinition } from "./tools/tool.js";

/**
 * Entrypoint do MCP Server do Botpress.
 *
 * Roda localmente via stdio para ser consumido pelo Claude Code. NUNCA escreva
 * em stdout com console.log: isso corromperia o protocolo JSON-RPC. Use
 * console.error para logs/diagnóstico (vai para stderr).
 *
 * TODAS as tools são SOMENTE LEITURA. Ver a nota em botpress/management-client.ts:
 * a Management API não permite gravar fluxos/hooks/guidelines, e o que ela
 * permite gravar tem efeito imediato no bot publicado.
 */

const server = new McpServer({
  name: "botpress-mcp-server",
  version: "0.2.0",
});

// Registre aqui todas as tools. Para adicionar uma nova, crie o arquivo em
// src/tools/ exportando um ToolDefinition e inclua-o nesta lista.
const tools: ToolDefinition[] = [
  // Descoberta
  listBotsTool,
  getBotOverviewTool,
  // Análise de conteúdo
  grepBotContentTool,
  inspectFlowTool,
  getBotCodeTool,
  // Consistência entre bots
  compareBotsTool,
  auditAllBotsTool,
  // Runtime / HITL
  listConversationsTool,
  inspectHitlTool,
  // Conversar com o bot
  sendMessageToBotpressTool,
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
    `[botpress-mcp-server] conectado via stdio. ${tools.length} tools: ${tools
      .map((tool) => tool.name)
      .join(", ")}`,
  );
}

main().catch((err) => {
  console.error("[botpress-mcp-server] erro fatal ao iniciar:", err);
  process.exit(1);
});
