/**
 * Smoke test das tools de leitura contra a API real do Botpress.
 *
 *   npm run smoke
 *
 * Faz apenas chamadas GET. Não altera nada no Botpress.
 *
 * Não é teste unitário: valida que as chamadas funcionam, que a redação de
 * segredos está ativa e que os analisadores encontram o que deveriam. Exige um
 * .env válido e conectividade.
 */
import { getBotContent, listBots, listConversations } from "../src/botpress/management-client.js";
import { grepContent, summarizeContent } from "../src/botpress/content.js";
import {
  auditRules,
  censusConversationTags,
  findSuspiciousTagAccess,
  type NamedBot,
} from "../src/botpress/diff.js";
import { resolveBotId } from "../src/config/env.js";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "✅" : "❌";
  if (!condition) failures++;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

async function main() {
  section("1. listBots");
  const bots = await listBots();
  check("lista bots", bots.length > 0, `${bots.length} bot(s)`);
  check(
    "bots têm id e name",
    bots.every((bot) => Boolean(bot.id && bot.name)),
  );

  const botId = resolveBotId();
  const target = bots.find((bot) => bot.id === botId);
  check("bot do .env existe no workspace", Boolean(target), target?.name ?? botId);

  section("2. getBotContent + redação de segredos");
  const content = await getBotContent(botId);
  check("baixou conteúdo", Boolean(content), `${(content.flows ?? []).length} fluxos`);
  check("tem knowledge bases", (content.knowledge_base ?? []).length > 0);
  check("tem hooks", (content.hooks ?? []).length > 0);

  const configVariables = content.settings?.configVariables ?? {};
  const configValues = Object.values(configVariables) as unknown[];
  check(
    "configVariables redigidas",
    configValues.length === 0 ||
      configValues.every((value) => String(value).startsWith("<redacted")),
    `${configValues.length} variável(is)`,
  );

  const serialized = JSON.stringify(content);
  check(
    "nenhum token da Meta em claro",
    !/EAA[A-Za-z0-9]{40,}/.test(serialized),
    "padrão de access token do Facebook",
  );

  section("3. cache");
  const started = Date.now();
  await getBotContent(botId);
  const elapsed = Date.now() - started;
  check("2ª leitura vem do cache", elapsed < 500, `${elapsed}ms`);

  section("4. grepContent");
  const cupom = grepContent(content, String.raw`\bcupom fiscal`, { maxMatches: 5 });
  check("acha 'cupom fiscal'", cupom.total > 0, `${cupom.total} ocorrência(s)`);
  check(
    "match traz localização legível",
    cupom.matches.every((match) => match.location.length > 0),
    cupom.matches[0]?.location,
  );

  const bogus = grepContent(content, "zzz_nao_existe_zzz");
  check("padrão inexistente devolve zero", bogus.total === 0);

  let regexErrorRaised = false;
  try {
    grepContent(content, "[invalida");
  } catch {
    regexErrorRaised = true;
  }
  check("regex inválida lança erro tratável", regexErrorRaised);

  section("5. summarizeContent");
  const summary = summarizeContent(content);
  check("resumo não vazio", summary.length > 200, `${summary.length} chars`);
  check("resumo lista fluxos", summary.includes("## Fluxos"));

  section("6. conversas e tags de HITL");
  const conversations = await listConversations(botId, 40);
  check("lista conversas", conversations.length > 0, `${conversations.length}`);
  const census = censusConversationTags(conversations);
  check("censo de tags gerado", census.includes("Chaves de tag"));
  console.log(census.split("\n").slice(0, 14).join("\n"));

  section("7. acessos suspeitos a tags no código");
  const suspicious = findSuspiciousTagAccess(content);
  console.log(suspicious.slice(0, 1200));

  section("8. auditoria de regras");
  const named: NamedBot[] = [{ label: target?.name ?? botId, botId, content }];
  const audit = auditRules(named);
  check("auditoria gerada", audit.includes("Auditoria de consistência"));
  console.log(audit);

  section("Resultado");
  if (failures) {
    console.error(`❌ ${failures} verificação(ões) falharam.`);
    process.exit(1);
  }
  console.log("✅ Todas as verificações passaram.");
}

main().catch((err) => {
  console.error("\n💥 Smoke test falhou:", err);
  process.exit(1);
});
