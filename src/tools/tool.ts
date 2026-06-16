import { z } from "zod";

/**
 * Contrato de uma tool MCP neste projeto. Cada tool exporta um objeto neste
 * formato e o `index.ts` apenas registra a lista. Para criar uma nova tool,
 * crie um arquivo em src/tools/ exportando um `ToolDefinition`.
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}
