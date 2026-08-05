import { z } from "zod";
import {
  renderFlow,
  renderRouteMap,
  selectFlows,
  truncate,
} from "../botpress/content.js";
import { resolveBotId } from "../config/env.js";
import { getBotContent } from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  flow: z
    .string()
    .describe(
      'Índice ("13"), id ("wf-eab1d1e801") ou parte do nome ("Nota Fiscal", "SLA"). ' +
        "Use get_bot_overview para ver a lista.",
    ),
  botId: botIdSchema,
  mode: z
    .enum(["routemap", "full"])
    .optional()
    .default("routemap")
    .describe(
      "routemap = grafo compacto (nó → condição → destino), ideal para entender roteamento. " +
        "full = tudo, incluindo o texto completo das guidelines dos agentes.",
    ),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .default(40_000)
    .describe("Teto de caracteres da resposta."),
};

export const inspectFlowTool: ToolDefinition = {
  name: "inspect_flow",
  title: "Inspecionar um fluxo",
  description:
    "Renderiza um ou mais fluxos de forma legível. Em modo 'routemap' mostra o grafo de " +
    "roteamento (condições de transição, chamadas de skill, startHitl, capturas com seus " +
    "retries/handleFailure) — use para diagnosticar para onde uma conversa é encaminhada. " +
    "Em modo 'full' inclui o texto integral das guidelines, que é onde vive a lógica dos " +
    "agentes autônomos.",
  inputSchema,
  handler: safeHandler(async ({ flow, botId, mode = "routemap", maxChars = 40_000 }) => {
    const id = resolveBotId(botId);
    const content = await getBotContent(id);
    const selected = selectFlows(content, flow);

    if (!selected.length) {
      const available = (content.flows ?? [])
        .map((item, index) => `  [${index}] ${item.name}`)
        .join("\n");
      return `Nenhum fluxo casou com "${flow}".\n\nFluxos disponíveis:\n${available}`;
    }

    if (selected.length > 6) {
      const names = selected.map((item) => `  ${item.name}`).join("\n");
      return (
        `"${flow}" casou com ${selected.length} fluxos — seja mais específico.\n\n${names}`
      );
    }

    const rendered = selected
      .map((item) => (mode === "full" ? renderFlow(item, { maxChars }) : renderRouteMap(item)))
      .join("\n\n");

    return truncate(rendered, maxChars);
  }),
};
