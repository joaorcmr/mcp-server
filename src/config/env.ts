import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Carrega o .env uma única vez quando este módulo é importado.
//
// IMPORTANTE: resolvemos o caminho do .env a partir da localização deste
// módulo (não do process.cwd()). Quando o Claude Code sobe o MCP server, o
// cwd pode ser qualquer diretório; sem isto o dotenv não acharia o .env e as
// tools de Management falhariam. Este arquivo fica em <repo>/src/config (ou
// <repo>/dist/config quando compilado), então o .env está dois níveis acima.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(moduleDir, "../../.env");
loadDotenv({ path: envPath });

/**
 * Lê uma variável de ambiente obrigatória e lança um erro legível
 * caso ela não esteja definida.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variável de ambiente "${name}" não definida. ` +
        `Configure-a no seu .env (veja .env.example) antes de usar esta tool.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * Configuração da Chat API — usada para CONVERSAR com o bot
 * (enviar mensagens e receber respostas).
 *
 * Validada de forma "lazy": só falha quando uma tool que depende dela
 * é realmente chamada, permitindo que o servidor suba mesmo sem todas
 * as credenciais configuradas.
 */
export function getChatConfig() {
  return {
    webhookId: required("BOTPRESS_WEBHOOK_ID"),
    // O SDK @botpress/chat espera `baseApiUrl` na variante por webhook e usa
    // https://chat.botpress.cloud por padrão; só sobrescrevemos se configurado.
    baseApiUrl: process.env.BOTPRESS_CHAT_API_URL?.trim() || undefined,
  };
}

/**
 * Configuração da Management/Client API — usada para GERENCIAR o bot
 * (tabelas, bases de conhecimento, info do bot, etc.).
 *
 * Ainda não consumida pelo MVP, mas já disponível para as próximas tools.
 */
export function getManagementConfig() {
  return {
    token: required("BOTPRESS_TOKEN"),
    botId: required("BOTPRESS_BOT_ID"),
    workspaceId: required("BOTPRESS_WORKSPACE_ID"),
    apiUrl: optional("BOTPRESS_API_BASE_URL", "https://api.botpress.cloud"),
  };
}
2