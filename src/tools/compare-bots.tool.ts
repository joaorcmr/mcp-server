import { z } from "zod";
import { auditRules, diffBots, type NamedBot } from "../botpress/diff.js";
import { resolveBotId } from "../config/env.js";
import { getBot, getBotContent } from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  botIds: z
    .array(z.string())
    .min(1)
    .describe(
      "IDs dos bots a comparar. Com 2, faz o diff estrutural completo. " +
        "Com 1 ou 3+, roda apenas a auditoria de regras.",
    ),
  mode: z
    .enum(["rules", "structure", "both"])
    .optional()
    .default("both")
    .describe(
      "rules = auditoria de consistência das regras de negócio · " +
        "structure = diff de fluxos/KBs/hooks/actions/settings · both = os dois.",
    ),
};

export const compareBotsTool: ToolDefinition = {
  name: "compare_bots",
  title: "Comparar bots e auditar consistência",
  description:
    "Compara o conteúdo de bots do workspace. Nada no Botpress sincroniza fluxos ou KBs entre " +
    "bots — cada um tem sua cópia e as regras divergem em silêncio. Esta tool mostra o diff " +
    "estrutural (o que existe em um e não no outro) e audita regras de negócio críticas da Omni " +
    "(prazo de bloqueio por cupom fiscal, orientação do botão Cobertura, exigência de " +
    "prescrição, cobertura de homeopáticos, horário divulgado), apontando em qual fluxo e nó " +
    "está cada valor errado.",
  inputSchema,
  handler: safeHandler(async ({ botIds, mode = "both" }) => {
    const ids: string[] = botIds.length ? botIds : [resolveBotId()];

    const bots: NamedBot[] = [];
    for (const id of ids) {
      const [detail, content] = await Promise.all([getBot(id), getBotContent(id)]);
      bots.push({ label: (detail.name as string) ?? id, botId: id, content });
    }

    const sections: string[] = [];

    if (mode === "structure" || mode === "both") {
      if (bots.length === 2) {
        sections.push(diffBots(bots[0], bots[1]));
      } else if (mode === "structure") {
        sections.push(
          `Diff estrutural exige exatamente 2 bots (recebi ${bots.length}). ` +
            "Rodando só a auditoria de regras.",
        );
      }
    }

    if (mode === "rules" || mode === "both") {
      sections.push(auditRules(bots));
    }

    return sections.join("\n\n" + "─".repeat(90) + "\n\n");
  }),
};

/** Variante de conveniência: audita TODOS os bots com tráfego real. */
export const auditAllBotsTool: ToolDefinition = {
  name: "audit_business_rules",
  title: "Auditar regras de negócio em vários bots",
  description:
    "Roda a auditoria de consistência das regras de negócio da Omni sobre uma lista de bots " +
    "(default: apenas o bot do .env). Aponta onde ainda existe valor obsoleto — por exemplo " +
    "'45 dias' onde já deveria ser '60 dias' — com fluxo e nó exatos para corrigir no Studio.",
  inputSchema: {
    botIds: z
      .array(z.string())
      .optional()
      .describe("IDs dos bots a auditar. Se omitido, usa apenas BOTPRESS_BOT_ID do .env."),
    botId: botIdSchema,
  },
  handler: safeHandler(async ({ botIds, botId }) => {
    const ids: string[] = botIds?.length ? botIds : [resolveBotId(botId)];

    const bots: NamedBot[] = [];
    for (const id of ids) {
      const [detail, content] = await Promise.all([getBot(id), getBotContent(id)]);
      bots.push({ label: (detail.name as string) ?? id, botId: id, content });
    }

    return auditRules(bots);
  }),
};
