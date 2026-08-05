import { z } from "zod";
import { getBot, listBots, listConversations } from "../botpress/management-client.js";
import { safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  checkActivity: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Consulta conversas recentes de cada bot para distinguir produção de cópia/teste. Mais lento.",
    ),
  includeIntegrations: z
    .boolean()
    .optional()
    .default(true)
    .describe("Inclui as integrações de canal (whatsapp, webchat, zendesk, chat) e seu status."),
};

/** Integrações que indicam que um bot atende usuários de verdade. */
const CHANNEL_INTEGRATIONS = new Set(["whatsapp", "webchat", "zendesk", "chat", "hitl"]);

export const listBotsTool: ToolDefinition = {
  name: "list_bots",
  title: "Listar bots do workspace",
  description:
    "Inventário de todos os bots do workspace Botpress: nome, ID, data do último deploy, " +
    "integrações de canal e sinal de tráfego real (conversas recentes). Use para descobrir " +
    "quais bots estão em produção antes de analisar ou comparar conteúdo.",
  inputSchema,
  handler: safeHandler(async ({ checkActivity = true, includeIntegrations = true }) => {
    const bots = await listBots();
    bots.sort((a, b) => (b.deployedAt ?? "").localeCompare(a.deployedAt ?? ""));

    const lines: string[] = [];
    lines.push(`# ${bots.length} bot(s) no workspace\n`);

    for (const bot of bots) {
      lines.push(`## ${bot.name}`);
      lines.push(`   id:       ${bot.id}`);
      lines.push(
        `   deploy:   ${bot.deployedAt?.slice(0, 19).replace("T", " ") ?? "nunca publicado"}`,
      );

      if (includeIntegrations) {
        try {
          const detail = await getBot(bot.id);
          const integrations = Object.values(detail.integrations ?? {}) as any[];
          const channels = integrations
            .filter((integration) => CHANNEL_INTEGRATIONS.has(integration.name))
            .map(
              (integration) =>
                `${integration.name}:${integration.enabled ? "on" : "off"}/${integration.status}`,
            );
          lines.push(`   canais:   ${channels.join(", ") || "nenhum"}`);

          const failed = integrations
            .filter((integration) => integration.status !== "registered")
            .map((integration) => `${integration.name} (${integration.status})`);
          if (failed.length) {
            lines.push(`   ⚠️ falhas: ${failed.join(", ")}`);
          }
        } catch (err) {
          lines.push(
            `   canais:   (erro ao consultar: ${err instanceof Error ? err.message : err})`,
          );
        }
      }

      if (checkActivity) {
        try {
          const conversations = await listConversations(bot.id, 10);
          if (!conversations.length) {
            lines.push("   tráfego:  ❌ nenhuma conversa — provável cópia/teste");
          } else {
            const latest = conversations
              .map((conversation) => conversation.updatedAt ?? "")
              .sort()
              .pop();
            const integrations = [
              ...new Set(conversations.map((conversation) => conversation.integration)),
            ];
            lines.push(
              `   tráfego:  ✅ ${conversations.length} conversa(s), última ${latest?.slice(0, 19).replace("T", " ")} ` +
                `via ${integrations.join(", ")}`,
            );
          }
        } catch (err) {
          lines.push(
            `   tráfego:  (erro ao consultar: ${err instanceof Error ? err.message : err})`,
          );
        }
      }

      lines.push("");
    }

    lines.push(
      "\nDica: bots cujas conversas são *só* do canal `zendesk`/`hitl`, sem whatsapp nem webchat " +
        "próprios, costumam estar espelhando os eventos Zendesk de outro bot — vale investigar.",
    );

    return lines.join("\n");
  }),
};
