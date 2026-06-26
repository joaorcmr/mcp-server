import { z } from "zod";
import { getBotAnalytics } from "../botpress/management-client.js";
import { formatBotpressError } from "../botpress/errors.js";
import type { ToolDefinition } from "./tool.js";

export const getBotAnalyticsTool: ToolDefinition = {
  name: "get_bot_analytics",
  title: "Buscar analytics do bot",
  description:
    "Lê as métricas agregadas do bot (Admin API getBotAnalytics) — a mesma fonte do painel de " +
    "Analytics do Botpress. startDate e endDate são OBRIGATÓRIOS (ISO 8601). Retorna uma lista de " +
    "buckets (normalmente um por dia) com: usuários novos/recorrentes, sessões, mensagens do usuário " +
    "e do bot, eventos (eventTypes/customEvents) e uso de LLM (chamadas, erros, tokens, latência e " +
    "custo em USD). Útil para KPIs de volume e custo ao longo do tempo.",
  inputSchema: {
    startDate: z.string().describe("Início do período (ISO 8601). OBRIGATÓRIO."),
    endDate: z.string().describe("Fim do período (ISO 8601). OBRIGATÓRIO."),
  },
  handler: async (args) => {
    try {
      const { records } = await getBotAnalytics(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, count: records.length, records }, null, 2),
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
