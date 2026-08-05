import { z } from "zod";
import { truncate } from "../botpress/content.js";
import { resolveBotId } from "../config/env.js";
import { getBotContent } from "../botpress/management-client.js";
import { botIdSchema, safeHandler, type ToolDefinition } from "./tool.js";

const inputSchema = {
  botId: botIdSchema,
  kind: z
    .enum(["hooks", "actions", "node-code", "all"])
    .optional()
    .default("all")
    .describe(
      "hooks = hooks do bot · actions = code actions · node-code = blocos 'Execute code' dentro dos fluxos · all = tudo.",
    ),
  name: z
    .string()
    .optional()
    .describe("Filtra por parte do nome do hook/action/label do bloco de código."),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .default(50_000)
    .describe("Teto de caracteres da resposta."),
};

export const getBotCodeTool: ToolDefinition = {
  name: "get_bot_code",
  title: "Ler o código do bot",
  description:
    "Devolve o código-fonte dos hooks, das code actions e dos blocos 'Execute code' embutidos " +
    "nos nós dos fluxos. Sempre a versão fonte, nunca a transpilada. Use para auditar lógica de " +
    "horário comercial, integração com Zendesk, escrita em tables e validações.",
  inputSchema,
  handler: safeHandler(async ({ botId, kind = "all", name, maxChars = 50_000 }) => {
    const id = resolveBotId(botId);
    const content = await getBotContent(id);
    const needle = name?.trim().toLowerCase();
    const lines: string[] = [];
    let found = 0;

    const matchesName = (candidate?: string) =>
      !needle || (candidate ?? "").toLowerCase().includes(needle);

    if (kind === "hooks" || kind === "all") {
      for (const hook of content.hooks ?? []) {
        if (!matchesName(hook.name)) continue;
        found++;
        lines.push("#".repeat(90));
        lines.push(`HOOK: ${hook.name}   |   tipo: ${hook.type}`);
        lines.push("#".repeat(90));
        lines.push(hook.code ?? "(sem código fonte — só há a versão transpilada)");
        lines.push("");
      }
    }

    if (kind === "actions" || kind === "all") {
      for (const action of content.actions ?? []) {
        if (!matchesName(action.name)) continue;
        found++;
        lines.push("#".repeat(90));
        lines.push(`ACTION: ${action.name}   |   id: ${action.id}`);
        lines.push("#".repeat(90));
        lines.push(action.raw_code ?? "(sem código fonte)");
        lines.push("");
      }
    }

    if (kind === "node-code" || kind === "all") {
      (content.flows ?? []).forEach((flow) => {
        (flow.nodes ?? []).forEach((node) => {
          for (const instruction of node.instructions ?? []) {
            if (instruction.type !== "action" || instruction.category !== "Execute") continue;
            const label = (instruction.label as string) ?? "(sem label)";
            if (!matchesName(label) && !matchesName(node.name) && !matchesName(flow.name)) {
              continue;
            }
            const code = instruction.code as string | undefined;
            if (!code?.trim()) continue;
            found++;
            lines.push("#".repeat(90));
            lines.push(
              `NODE CODE: fluxo "${flow.name}" › nó "${node.name}" (${node.id})`,
            );
            lines.push(`label: ${label}`);
            lines.push("#".repeat(90));
            lines.push(code);
            lines.push("");
          }
        });
      });
    }

    if (!found) {
      return `Nenhum código encontrado para kind=${kind}${needle ? ` e nome contendo "${name}"` : ""}.`;
    }

    return truncate(`${found} bloco(s) de código.\n\n${lines.join("\n")}`, maxChars);
  }),
};
