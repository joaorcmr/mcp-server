import { describeLocation, grepContent, stripHtml, walkStrings } from "./content.js";
import type { BotContent } from "./types.js";

/**
 * Comparação entre bots.
 *
 * O workspace tem vários bots atendendo usuários reais (Support Omni,
 * Onboarding Omni, Webchat Care Plus) e nada no Botpress sincroniza conteúdo
 * entre eles: cada um tem sua própria cópia de fluxos e KBs. Na prática as
 * regras divergem em silêncio. Estas funções tornam essa divergência visível.
 */

export interface NamedBot {
  label: string;
  botId: string;
  content: BotContent;
}

function namesOf(content: BotContent, section: "flows" | "knowledge_base" | "hooks" | "actions"): string[] {
  const items = (content[section] ?? []) as Array<{ name?: string }>;
  return items.map((item) => item.name ?? "(sem nome)").sort();
}

function diffSets(a: string[], b: string[]) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: a.filter((item) => !setB.has(item)),
    onlyB: b.filter((item) => !setA.has(item)),
    shared: a.filter((item) => setB.has(item)),
  };
}

export function diffBots(a: NamedBot, b: NamedBot): string {
  const lines: string[] = [];

  lines.push(`# Diff estrutural: "${a.label}" × "${b.label}"`);
  lines.push(`  A = ${a.label} (${a.botId})`);
  lines.push(`  B = ${b.label} (${b.botId})`);

  lines.push("\n## Contagens");
  const sections = ["flows", "knowledge_base", "hooks", "actions"] as const;
  for (const section of sections) {
    const countA = ((a.content[section] ?? []) as unknown[]).length;
    const countB = ((b.content[section] ?? []) as unknown[]).length;
    const flag = countA === countB ? "  " : "🔴";
    lines.push(`  ${flag} ${section.padEnd(16)} A=${countA}  B=${countB}`);
  }
  const tablesA = Object.keys(a.content.tables ?? {}).length;
  const tablesB = Object.keys(b.content.tables ?? {}).length;
  lines.push(
    `  ${tablesA === tablesB ? "  " : "🔴"} ${"tables".padEnd(16)} A=${tablesA}  B=${tablesB}`,
  );

  for (const section of sections) {
    const { onlyA, onlyB } = diffSets(namesOf(a.content, section), namesOf(b.content, section));
    if (!onlyA.length && !onlyB.length) continue;
    lines.push(`\n## ${section} — presentes em apenas um dos bots`);
    for (const name of onlyA) lines.push(`  só em A (${a.label}):  ${name}`);
    for (const name of onlyB) lines.push(`  só em B (${b.label}):  ${name}`);
  }

  lines.push("\n## Settings divergentes");
  const interesting = [
    "defaultLanguage",
    "languages",
    "defaultBestModel",
    "defaultFastModel",
    "autonomousModel",
    "fallbackModel",
    "useLlmz",
    "nodeRepetitionLimit",
    "inactivityTimeout",
    "usePushToGit",
    "disablePublishButton",
  ];
  let anyDiff = false;
  for (const key of interesting) {
    const valueA = JSON.stringify((a.content.settings ?? {})[key]);
    const valueB = JSON.stringify((b.content.settings ?? {})[key]);
    if (valueA !== valueB) {
      anyDiff = true;
      lines.push(`  🔴 ${key.padEnd(22)} A=${valueA}  B=${valueB}`);
    }
  }
  if (!anyDiff) lines.push("  (nenhuma)");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Auditoria de regra de negócio entre bots
// ---------------------------------------------------------------------------

export interface RuleCheck {
  /** Nome legível da regra, ex.: "prazo de bloqueio por cupom fiscal". */
  name: string;
  /** Padrão do valor CORRETO. Opcional: há regras que só têm valor proibido. */
  expected?: string;
  /** Padrão do valor ERRADO/obsoleto que não deveria mais existir. */
  forbidden?: string;
}

/**
 * Regras de negócio da Omni que precisam estar consistentes em todos os bots.
 * Editar aqui quando uma regra mudar — é o ponto único de verdade da auditoria.
 */
export const DEFAULT_RULE_CHECKS: RuleCheck[] = [
  {
    name: "Prazo de bloqueio por cupom fiscal",
    expected: String.raw`\b60\s*dias`,
    forbidden: String.raw`\b45\s*dias`,
  },
  {
    name: 'Orientação do botão "Cobertura" no app',
    expected: String.raw`bot[ãa]o\s+\*?\*?Cobertura|aba\s+Cobertura|Buscar\s+Cobertura`,
  },
  {
    name: "Exigência de prescrição médica",
    forbidden: String.raw`n[ãa]o\s+precisa\s+necessariamente\s+de\s+(uma\s+)?prescri[çc][ãa]o`,
    expected: String.raw`prescri[çc][ãa]o\s+m[ée]dica\s+(é\s+)?obrigat[óo]ri`,
  },
  {
    name: "Cobertura de homeopáticos (não são cobertos)",
    forbidden: String.raw`homeop[áa]tic\w*\s+(s[ãa]o|est[ãa]o)\s+cobert`,
  },
  {
    name: "Horário comercial divulgado ao usuário",
    expected: String.raw`09h\s*[àa]s\s*19h|9h\s*[àa]s\s*19h`,
  },
];

export function auditRules(
  bots: NamedBot[],
  checks: RuleCheck[] = DEFAULT_RULE_CHECKS,
): string {
  const lines: string[] = [];
  lines.push(`# Auditoria de consistência de regras — ${bots.length} bot(s)`);
  lines.push(
    "\nLegenda: ✅ só o valor correto · 🔴 contém o valor proibido · ⚠️ regra ausente\n",
  );

  for (const check of checks) {
    lines.push(`\n## ${check.name}`);

    for (const bot of bots) {
      const expectedHits = check.expected
        ? grepContent(bot.content, check.expected, { maxMatches: 200 }).total
        : 0;
      const forbiddenResult = check.forbidden
        ? grepContent(bot.content, check.forbidden, { maxMatches: 200 })
        : { total: 0, matches: [] as ReturnType<typeof grepContent>["matches"] };

      let status: string;
      if (forbiddenResult.total > 0) status = "🔴";
      else if (check.expected && expectedHits === 0) status = "⚠️";
      else status = "✅";

      lines.push(
        `  ${status} ${bot.label.padEnd(30)} correto=${expectedHits}  proibido=${forbiddenResult.total}`,
      );

      // Onde exatamente está o valor proibido — é o que se precisa corrigir.
      const seen = new Set<string>();
      for (const match of forbiddenResult.matches) {
        if (seen.has(match.location)) continue;
        seen.add(match.location);
        lines.push(`        ↳ ${match.location}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Censo de tags reais de conversa
// ---------------------------------------------------------------------------

/**
 * Conta as chaves de tag realmente presentes nas conversas.
 *
 * Serve para validar código que lê tags: o plugin HITL prefixa tudo com
 * `hitl#` (`hitl#downstream`, `hitl#humanAgentName`), e é fácil escrever
 * `tags.downstream` por engano — o acesso devolve undefined em silêncio,
 * sem erro, e a funcionalidade simplesmente não roda.
 */
export function censusConversationTags(
  conversations: Array<{ tags?: Record<string, string>; integration?: string }>,
): string {
  const tagCounts = new Map<string, number>();
  const integrationCounts = new Map<string, number>();

  for (const conversation of conversations) {
    for (const key of Object.keys(conversation.tags ?? {})) {
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    }
    const integration = conversation.integration ?? "(desconhecida)";
    integrationCounts.set(integration, (integrationCounts.get(integration) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(`Amostra: ${conversations.length} conversa(s)`);

  lines.push("\n## Integrações");
  for (const [name, count] of [...integrationCounts].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(4)}x  ${name}`);
  }

  lines.push("\n## Chaves de tag observadas");
  for (const [key, count] of [...tagCounts].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(4)}x  ${key}`);
  }

  const prefixed = [...tagCounts.keys()].filter((key) => key.includes("#"));
  if (prefixed.length) {
    lines.push(
      "\n⚠️  Tags com prefixo de plugin — no código elas precisam ser lidas como\n" +
        `    tags["${prefixed[0]}"], não tags.${prefixed[0].split("#")[1]}:`,
    );
    for (const key of prefixed) lines.push(`      ${key}`);
  }

  return lines.join("\n");
}

/** Localiza no conteúdo acessos a tags de HITL sem o prefixo `hitl#`. */
export function findSuspiciousTagAccess(content: BotContent): string {
  const suspects = [
    "downstream",
    "upstream",
    "humanAgentName",
    "humanAgentId",
    "hitlEndReason",
    "startMessageId",
  ];

  const lines: string[] = [];
  for (const { path, value } of walkStrings(content)) {
    if (!path.includes("code") && !path.includes("Code")) continue;
    if (path.includes("transpiled")) continue;

    for (const suspect of suspects) {
      // tags.downstream / tags?.downstream / tags['downstream'] — sem `hitl#`
      const pattern = new RegExp(
        String.raw`tags\s*\??\.\s*${suspect}\b|tags\s*\??\[\s*['"\`]${suspect}['"\`]\s*\]`,
        "g",
      );
      const text = stripHtml(value);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const start = Math.max(0, match.index - 80);
        lines.push(
          `🔴 ${describeLocation(content, path)}\n` +
            `      ${text.slice(start, match.index + match[0].length + 80).replace(/\s+/g, " ").trim()}\n` +
            `      → provável correção: tags["hitl#${suspect}"]`,
        );
      }
    }
  }

  if (!lines.length) {
    return "✅ Nenhum acesso suspeito a tags de HITL sem o prefixo `hitl#`.";
  }
  return (
    `Encontrado(s) ${lines.length} acesso(s) suspeito(s) a tags de HITL.\n` +
    "O plugin HITL grava as tags com prefixo `hitl#`; sem ele o acesso devolve\n" +
    "undefined silenciosamente e a funcionalidade não roda.\n\n" +
    lines.join("\n\n")
  );
}
