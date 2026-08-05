import type {
  BotContent,
  DynamicValue,
  Flow,
  FlowNode,
  Instruction,
} from "./types.js";

/**
 * Utilitários de análise do conteúdo do bot.
 *
 * Boa parte da lógica de negócio deste bot vive como TEXTO — as guidelines dos
 * nós autônomos (LLMz) são prompts em markdown, e as KBs são HTML rich-text.
 * Por isso as ferramentas mais úteis aqui são de busca textual com rastreio de
 * origem (qual fluxo, qual nó), e não de navegação estruturada.
 */

// ---------------------------------------------------------------------------
// Travessia e extração de texto
// ---------------------------------------------------------------------------

export interface StringHit {
  /** Caminho no JSON, ex.: `.flows[27].nodes[2].guidelines.dynamicValue` */
  path: string;
  value: string;
}

/** Percorre a estrutura e emite todo valor string com seu caminho JSON. */
export function* walkStrings(
  value: unknown,
  path = "",
): Generator<StringHit> {
  if (typeof value === "string") {
    yield { path, value };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walkStrings(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      yield* walkStrings(inner, `${path}.${key}`);
    }
  }
}

/** Converte o HTML das KBs rich-text em texto legível. */
export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h1|h2|h3|h4|li|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

function looksLikeHtml(input: string): boolean {
  return /<(p|h[1-6]|br|div|strong|ul|li)\b/i.test(input);
}

/** Extrai texto de um campo do Studio (string, {dynamicValue}, lista…). */
export function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const parts = value.map(textOf).filter(Boolean) as string[];
    return parts.length ? parts.join("\n") : undefined;
  }

  if (typeof value === "object") {
    const dyn = value as DynamicValue;
    for (const key of ["dynamicValue", "staticValue", "value", "text", "html"]) {
      const inner = (dyn as Record<string, unknown>)[key];
      if (typeof inner === "string" && inner.trim()) return inner;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Localização legível: transforma um caminho JSON em "fluxo / nó"
// ---------------------------------------------------------------------------

const FLOW_NODE_PATH = /^\.flows\[(\d+)\](?:\.nodes\[(\d+)\])?/;
const KB_PATH = /^\.knowledge_base\[(\d+)\]/;
const HOOK_PATH = /^\.hooks\[(\d+)\]/;
const ACTION_PATH = /^\.actions\[(\d+)\]/;

/**
 * Traduz um caminho JSON para uma referência que dá para achar no Studio.
 * Ex.: `.flows[27].nodes[2].guidelines.dynamicValue`
 *   →  `fluxo "9. Nota Fiscal" › nó "9_Nota_Fiscal" (nd-13d5f07b02)`
 */
export function describeLocation(content: BotContent, path: string): string {
  const flowMatch = FLOW_NODE_PATH.exec(path);
  if (flowMatch) {
    const flow = content.flows?.[Number(flowMatch[1])];
    const flowName = flow?.name ?? `flows[${flowMatch[1]}]`;
    if (flowMatch[2] === undefined) return `fluxo "${flowName}"`;

    const node = flow?.nodes?.[Number(flowMatch[2])];
    const nodeName = node?.name ?? `nodes[${flowMatch[2]}]`;
    return `fluxo "${flowName}" › nó "${nodeName}" (${node?.id ?? "?"})`;
  }

  const kbMatch = KB_PATH.exec(path);
  if (kbMatch) {
    const kb = content.knowledge_base?.[Number(kbMatch[1])];
    return `KB "${kb?.name ?? kbMatch[1]}" (${kb?.id ?? "?"})`;
  }

  const hookMatch = HOOK_PATH.exec(path);
  if (hookMatch) {
    const hook = content.hooks?.[Number(hookMatch[1])];
    return `hook "${hook?.name ?? hookMatch[1]}" (${hook?.type ?? "?"})`;
  }

  const actionMatch = ACTION_PATH.exec(path);
  if (actionMatch) {
    const action = content.actions?.[Number(actionMatch[1])];
    return `action "${action?.name ?? actionMatch[1]}" (${action?.id ?? "?"})`;
  }

  if (path.startsWith(".settings")) return "settings do bot";
  return path.split(".").slice(0, 3).join(".") || "(raiz)";
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

export interface GrepMatch {
  location: string;
  path: string;
  snippet: string;
}

export interface GrepOptions {
  /** Ignora blobs de código transpilado (ruído). Default: true. */
  skipTranspiled?: boolean;
  /** Caracteres de contexto ao redor do match. Default: 160. */
  context?: number;
  /** Teto de matches retornados. Default: 60. */
  maxMatches?: number;
  /** Restringe a seções: flows, knowledge_base, hooks, actions, settings. */
  sections?: string[];
}

const NOISE_KEYS = [
  "transpiledCode",
  "transpiled_code",
  "__temporary_integration_schemas",
  "__temporary_plugin_schemas",
  "metadata.llmModels",
];

export function grepContent(
  content: BotContent,
  pattern: string,
  options: GrepOptions = {},
): { matches: GrepMatch[]; total: number; truncated: boolean } {
  const {
    skipTranspiled = true,
    context = 160,
    maxMatches = 60,
    sections,
  } = options;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "gi");
  } catch (err) {
    throw new Error(
      `Regex inválida: ${pattern} — ${err instanceof Error ? err.message : err}`,
    );
  }

  const matches: GrepMatch[] = [];
  let total = 0;

  for (const { path, value } of walkStrings(content)) {
    if (skipTranspiled && NOISE_KEYS.some((noise) => path.includes(noise))) {
      continue;
    }
    if (sections?.length) {
      const inScope = sections.some((section) =>
        path.startsWith(`.${section}`),
      );
      if (!inScope) continue;
    }

    const text = looksLikeHtml(value) ? stripHtml(value) : value;

    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      total++;
      if (matches.length < maxMatches) {
        const start = Math.max(0, match.index - context);
        const end = Math.min(text.length, match.index + match[0].length + context);
        matches.push({
          location: describeLocation(content, path),
          path,
          snippet:
            (start > 0 ? "…" : "") +
            text.slice(start, end).replace(/\s+/g, " ").trim() +
            (end < text.length ? "…" : ""),
        });
      }
      // Evita loop infinito com padrões que casam string vazia.
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
  }

  return { matches, total, truncated: total > matches.length };
}

// ---------------------------------------------------------------------------
// Panorama do bot
// ---------------------------------------------------------------------------

export function summarizeContent(content: BotContent): string {
  const lines: string[] = [];
  const settings = content.settings ?? {};

  lines.push("## Settings");
  lines.push(
    `  idioma: ${settings.defaultLanguage} (languages: ${JSON.stringify(settings.languages)})`,
  );
  lines.push(
    `  modelos: best=${settings.defaultBestModel} fast=${settings.defaultFastModel} autonomous=${settings.autonomousModel} fallback=${settings.fallbackModel}`,
  );
  lines.push(
    `  useLlmz=${settings.useLlmz} nodeRepetitionLimit=${settings.nodeRepetitionLimit} inactivityTimeout=${settings.inactivityTimeout}`,
  );
  lines.push(
    `  usePushToGit=${settings.usePushToGit} disablePublishButton=${settings.disablePublishButton}`,
  );

  const flows = content.flows ?? [];
  lines.push(`\n## Fluxos (${flows.length})`);
  flows.forEach((flow, index) => {
    const autonomous = (flow.nodes ?? []).filter(
      (node) => node.type === "autonomous",
    ).length;
    lines.push(
      `  [${index}] ${flow.name} — ${flow.nodes?.length ?? 0} nós` +
        (autonomous ? ` (${autonomous} autônomo${autonomous > 1 ? "s" : ""})` : "") +
        `  id=${flow.id}`,
    );
  });

  const kbs = content.knowledge_base ?? [];
  lines.push(`\n## Knowledge bases (${kbs.length})`);
  kbs.forEach((kb) => {
    const kinds = (kb.dataSources ?? []).map((ds) => ds.type).join(", ");
    lines.push(`  ${kb.name} — fontes: ${kinds || "nenhuma"}  id=${kb.id}`);
  });

  const hooks = content.hooks ?? [];
  lines.push(`\n## Hooks (${hooks.length})`);
  hooks.forEach((hook) =>
    lines.push(`  ${hook.name} — ${hook.type}`),
  );

  const actions = content.actions ?? [];
  lines.push(`\n## Actions (${actions.length})`);
  actions.forEach((action) =>
    lines.push(`  ${action.name} — id=${action.id}`),
  );

  const tables = Object.values(content.tables ?? {});
  lines.push(`\n## Tables (${tables.length})`);
  tables.forEach((table) => {
    const columns = Object.keys(table?.schema?.properties ?? {});
    lines.push(`  ${table.name} — ${columns.length} colunas: ${columns.join(", ")}`);
  });

  const conversationVars = settings.conversationVariables ?? [];
  const userVars = settings.userVariables ?? [];
  lines.push(
    `\n## Variáveis — conversation (${conversationVars.length}): ${conversationVars
      .map((v: any) => v.name)
      .join(", ")}`,
  );
  lines.push(
    `## Variáveis — user (${userVars.length}): ${userVars.map((v: any) => v.name).join(", ")}`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Seleção de fluxo
// ---------------------------------------------------------------------------

/** Aceita índice ("13"), id ("wf-eab1d1e801") ou parte do nome ("Nota Fiscal"). */
export function selectFlows(content: BotContent, selector?: string): Flow[] {
  const flows = content.flows ?? [];
  if (!selector?.trim()) return flows;

  const needle = selector.trim().toLowerCase();

  const byIndex = flows[Number(needle)];
  if (/^\d+$/.test(needle) && byIndex) return [byIndex];

  const exact = flows.filter(
    (flow) => flow.id?.toLowerCase() === needle || flow.name?.toLowerCase() === needle,
  );
  if (exact.length) return exact;

  return flows.filter((flow) => flow.name?.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Render de fluxo (detalhado) e mapa de rotas (compacto)
// ---------------------------------------------------------------------------

const DETAIL_FIELDS = [
  "instructions",
  "guidelines",
  "prompt",
  "message",
  "question",
  "code",
  "raw_code",
  "text",
  "expression",
  "condition",
] as const;

export function renderFlow(flow: Flow, options: { maxChars?: number } = {}): string {
  const { maxChars = 40_000 } = options;
  const lines: string[] = [];
  const nodeName = nodeNameResolver(flow);

  lines.push("=".repeat(90));
  lines.push(`FLUXO "${flow.name}"  id=${flow.id}  nós=${flow.nodes?.length ?? 0}`);
  lines.push(`início: ${nodeName(flow.startNode)}`);
  lines.push("=".repeat(90));

  (flow.nodes ?? []).forEach((node, index) => {
    lines.push(`\n┌─ node[${index}] «${node.name}»  id=${node.id}  type=${node.type}`);

    const guidelines = textOf(node.guidelines);
    if (guidelines) {
      lines.push("│ ▸ guidelines:");
      for (const line of guidelines.split("\n")) lines.push(`│   ${line}`);
    }

    for (const instruction of node.instructions ?? []) {
      lines.push(`│ ▸ ${describeInstruction(instruction, nodeName)}`);
      for (const field of DETAIL_FIELDS) {
        if (field === "instructions") continue;
        const raw = (instruction as Record<string, unknown>)[field];
        const text = textOf(raw);
        if (!text?.trim()) continue;
        const clean = looksLikeHtml(text) ? stripHtml(text) : text;
        lines.push(`│     ${field}:`);
        for (const line of clean.split("\n")) lines.push(`│       ${line}`);
      }
    }

    const fallback = node.defaultTransition?.targetNodeId;
    if (fallback) lines.push(`│ ▸ DEFAULT → ${nodeName(fallback)}`);
    lines.push("└─");
  });

  return truncate(lines.join("\n"), maxChars);
}

export function renderRouteMap(flow: Flow): string {
  const lines: string[] = [];
  const nodeName = nodeNameResolver(flow);

  lines.push("=".repeat(90));
  lines.push(`FLUXO "${flow.name}"  (início: ${nodeName(flow.startNode)})`);
  lines.push("=".repeat(90));

  for (const node of flow.nodes ?? []) {
    lines.push(`\n● «${node.name}» [${node.type}]`);
    for (const instruction of node.instructions ?? []) {
      lines.push(`    ${describeInstruction(instruction, nodeName)}`);
    }
    const fallback = node.defaultTransition?.targetNodeId;
    if (fallback) lines.push(`    DEFAULT → ${nodeName(fallback)}`);
  }

  return lines.join("\n");
}

function nodeNameResolver(flow: Flow) {
  const byId = new Map<string, string>();
  for (const node of flow.nodes ?? []) {
    if (node.id) byId.set(node.id, node.name ?? node.id);
  }
  return (id?: string | null): string => {
    if (!id) return "(nenhum)";
    return byId.get(id) ?? id;
  };
}

function describeInstruction(
  instruction: Instruction,
  nodeName: (id?: string | null) => string,
): string {
  const type = instruction.type;

  switch (type) {
    case "transition": {
      const condition = instruction.condition?.payload ?? "?";
      const target = nodeName(instruction.destination?.node);
      return `IF ${condition}  →  ${target}`;
    }
    case "skill":
      return `SKILL «${instruction.name}» → flow ${instruction.flowId}`;
    case "capture": {
      const question = textOf(instruction.question) ?? "?";
      const retries = instruction.retry?.maxRetries;
      const cancellable = (instruction.cancellation as any)?.confirmCancel;
      return (
        `ASK "${oneLine(question, 120)}" ` +
        `retries=${retries} handleFailure=${instruction.handleFailure} confirmCancel=${cancellable}`
      );
    }
    case "content": {
      const text = textOf(instruction.content?.text ?? instruction.content) ?? "";
      return `SAY "${oneLine(text, 160)}"`;
    }
    case "autonomous":
      return `AUTONOMOUS ${instruction.toolType} «${instruction.name ?? instruction.label}»`;
    case "action": {
      if (instruction.category === "Hitl") {
        const title = textOf(instruction.data?.title) ?? "?";
        return `START-HITL title="${oneLine(title, 120)}"`;
      }
      if (instruction.category === "Execute") {
        return `CODE «${instruction.label ?? "(sem label)"}»`;
      }
      return `ACTION ${instruction.category ?? ""} «${instruction.label ?? instruction.name ?? ""}»`;
    }
    case "log":
      return `LOG ${oneLine(textOf(instruction.message) ?? "", 80)}`;
    default:
      return `${type ?? "?"}: ${instruction.label ?? instruction.name ?? ""}`;
  }
}

function oneLine(input: string, max: number): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return (
    `${input.slice(0, maxChars)}\n\n` +
    `[...truncado: ${input.length - maxChars} caracteres omitidos. ` +
    `Refine o filtro ou aumente maxChars.]`
  );
}
