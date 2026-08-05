import { z } from "zod";
import { censusConversationTags, findSuspiciousTagAccess } from "../botpress/diff.js";
import { resolveBotId } from "../config/env.js";
import { getBotContent, listConversations } from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  botId: botIdSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(40)
    .describe("Quantas conversas recentes amostrar para o censo de tags."),
  checkCode: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Também varre o código do bot atrás de acessos a tags de HITL sem o prefixo `hitl#`.",
    ),
};

export const inspectHitlTool: ToolDefinition = {
  name: "inspect_hitl_tags",
  title: "Inspecionar tags de HITL",
  description:
    "Faz o censo das chaves de tag realmente presentes nas conversas recentes (whatsapp:*, " +
    "zendesk:id, hitl#downstream, hitl#humanAgentName…) e confronta com o código do bot, " +
    "sinalizando acessos como `tags.downstream` que deveriam ser `tags['hitl#downstream']`. " +
    "Esse tipo de erro devolve undefined em silêncio — sem exceção, sem log de falha — e " +
    "derruba funcionalidades inteiras, como o envio de imagens para o Zendesk.",
  inputSchema,
  handler: safeHandler(async ({ botId, limit = 40, checkCode = true }) => {
    const id = resolveBotId(botId);
    const conversations = await listConversations(id, limit);

    const sections: string[] = [];
    sections.push("# Tags reais observadas nas conversas\n");
    sections.push(censusConversationTags(conversations));

    if (checkCode) {
      const content = await getBotContent(id);
      sections.push("\n\n# Acessos a tags no código do bot\n");
      sections.push(findSuspiciousTagAccess(content));
    }

    return sections.join("\n");
  }),
};

export const listConversationsTool: ToolDefinition = {
  name: "list_conversations",
  title: "Listar conversas recentes",
  description:
    "Conversas recentes de um bot com canal, integração e tags. Útil para confirmar se um bot " +
    "tem tráfego real, entender por quais canais os usuários chegam e inspecionar o " +
    "encadeamento HITL (upstream do usuário ↔ downstream do agente no Zendesk).",
  inputSchema: {
    botId: botIdSchema,
    limit: z.number().int().min(1).max(100).optional().default(20),
    integration: z
      .string()
      .optional()
      .describe("Filtra por integração, ex.: 'whatsapp', 'webchat', 'zendesk'."),
  },
  handler: safeHandler(async ({ botId, limit = 20, integration }) => {
    const id = resolveBotId(botId);
    let conversations = await listConversations(id, limit);

    if (integration) {
      const needle = integration.toLowerCase();
      conversations = conversations.filter(
        (conversation) => conversation.integration?.toLowerCase() === needle,
      );
    }

    if (!conversations.length) {
      return `Nenhuma conversa${integration ? ` na integração "${integration}"` : ""} para o bot ${id}.`;
    }

    const lines: string[] = [`# ${conversations.length} conversa(s) — bot ${id}\n`];
    for (const conversation of conversations) {
      lines.push(
        `${conversation.updatedAt?.slice(0, 19).replace("T", " ") ?? "?"}  ` +
          `${(conversation.integration ?? "?").padEnd(9)} ${(conversation.channel ?? "?").padEnd(8)} ` +
          `${conversation.id}`,
      );
      const tags = Object.entries(conversation.tags ?? {});
      if (tags.length) {
        lines.push(
          `    ${tags.map(([key, value]) => `${key}=${value}`).join("  ")}`,
        );
      }
    }

    return lines.join("\n");
  }),
};
