import { config as loadDotenv } from "dotenv";

// Carrega o .env uma única vez quando este módulo é importado.
loadDotenv();

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

function optionalRaw(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
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
    // O SDK (@botpress/chat) espera `baseApiUrl`, não `apiUrl`. Manter o nome
    // alinhado ao SDK evita que BOTPRESS_CHAT_API_URL seja ignorado em silêncio.
    baseApiUrl: optionalRaw("BOTPRESS_CHAT_API_URL"),
  };
}

/**
 * Configuração da Management/Client API — usada para INSPECIONAR o workspace
 * (bots, fluxos, KBs, tabelas, conversas).
 *
 * `botId` é opcional aqui: endpoints de workspace (ex.: listar bots) não
 * precisam dele, e as tools que operam sobre um bot específico aceitam um
 * `botId` por parâmetro, caindo no default do .env quando omitido.
 */
export function getManagementConfig() {
  return {
    token: required("BOTPRESS_TOKEN"),
    workspaceId: required("BOTPRESS_WORKSPACE_ID"),
    defaultBotId: optionalRaw("BOTPRESS_BOT_ID"),
    apiUrl: optional("BOTPRESS_API_BASE_URL", "https://api.botpress.cloud"),
  };
}

/**
 * Resolve o bot alvo de uma tool: usa o informado, senão o default do .env.
 */
export function resolveBotId(botId?: string): string {
  const explicit = botId?.trim();
  if (explicit) return explicit;

  const { defaultBotId } = getManagementConfig();
  if (!defaultBotId) {
    throw new Error(
      "Nenhum bot informado e BOTPRESS_BOT_ID não está definido no .env. " +
        'Passe "botId" na chamada da tool ou configure o default. ' +
        "Use a tool list_bots para descobrir os IDs disponíveis.",
    );
  }
  return defaultBotId;
}
