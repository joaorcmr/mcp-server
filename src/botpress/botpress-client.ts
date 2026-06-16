import * as chat from "@botpress/chat";
import { getChatConfig } from "../config/env.js";

/**
 * Camada de acesso à API do Botpress.
 *
 * Hoje implementa apenas a Chat API (conversar com o bot). As funções de
 * gerenciamento (tables, KBs, etc.) virão aqui usando `@botpress/client`,
 * mantendo todas as chamadas HTTP isoladas neste módulo.
 */

/** Mensagem normalizada que devolvemos para a camada de tools. */
export interface BotMessage {
  id: string;
  /** id do autor (bot ou usuário) no Botpress. */
  authorId: string;
  /** payload cru da mensagem (ex.: { type: "text", text: "..." }). */
  payload: unknown;
  /** texto extraído quando a payload é do tipo "text". */
  text?: string;
  createdAt?: string;
}

export interface SendMessageResult {
  ok: true;
  conversationId: string;
  /** id do usuário de teste usado na Chat API. */
  userId: string;
  /** rótulo informativo recebido na entrada (echo do `userId` da tool). */
  requestedUserId?: string;
  /** mensagem que enviamos ao bot. */
  sent: { text: string };
  /** respostas do bot capturadas dentro da janela de espera. */
  replies: BotMessage[];
  /** true se a janela de espera expirou sem nenhuma resposta. */
  timedOut: boolean;
}

// O client da Chat API cria um usuário ao conectar; reutilizamos a mesma
// instância entre chamadas para não recriar usuário a cada mensagem.
let clientPromise: Promise<chat.AuthenticatedClient> | null = null;

async function getChatClient(): Promise<chat.AuthenticatedClient> {
  if (!clientPromise) {
    const { webhookId, baseApiUrl } = getChatConfig();
    clientPromise = chat.Client.connect({
      webhookId,
      ...(baseApiUrl ? { baseApiUrl } : {}),
    }).catch((err) => {
      // Permite uma nova tentativa de conexão no próximo uso.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Extrai o texto de uma payload de mensagem do Botpress, se houver. */
function extractText(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function toBotMessage(ev: {
  id: string;
  userId: string;
  payload: unknown;
  createdAt?: string;
}): BotMessage {
  return {
    id: ev.id,
    authorId: ev.userId,
    payload: ev.payload,
    text: extractText(ev.payload),
    createdAt: ev.createdAt,
  };
}

export interface SendMessageOptions {
  message: string;
  /** rótulo informativo do usuário de teste (echo na resposta). */
  userId?: string;
  /** tempo máximo (ms) aguardando a 1ª resposta do bot. Padrão: 30s. */
  timeoutMs?: number;
  /** após a 1ª resposta, espera adicional (ms) por mensagens extras. Padrão: 2s. */
  idleMs?: number;
}

/**
 * Cria uma conversa, envia a mensagem e aguarda a(s) resposta(s) do bot
 * via stream `listenConversation`. Retorna tudo de forma estruturada.
 */
export async function sendMessageToBot(
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const { message, userId, timeoutMs = 30_000, idleMs = 2_000 } = options;

  const client = await getChatClient();

  const { conversation } = await client.createConversation({});

  // Importante: começar a escutar ANTES de enviar, para não perder a resposta.
  const listener = await client.listenConversation({ id: conversation.id });

  const replies: BotMessage[] = [];
  let sendError: unknown;

  const timedOut = await new Promise<boolean>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const overallTimer = setTimeout(() => finish(true), timeoutMs);

    function finish(didTimeOut: boolean) {
      clearTimeout(overallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve(didTimeOut);
    }

    listener.on("message_created", (ev) => {
      // Só nos interessam as mensagens emitidas pelo bot.
      if (!ev.isBot) return;

      replies.push(toBotMessage(ev));

      // Debounce: espera um pouco por mensagens adicionais do bot antes de encerrar.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(false), idleMs);
    });

    // Envia a mensagem; se falhar, registra o erro e encerra a espera.
    client
      .createMessage({
        conversationId: conversation.id,
        payload: { type: "text", text: message },
      })
      .catch((err) => {
        sendError = err;
        finish(false);
      });
  });

  // disconnect é assíncrono; best-effort, não deve quebrar a resposta.
  await listener.disconnect().catch(() => {});

  // Se o envio em si falhou, propaga para a tool formatar o erro.
  if (sendError) {
    throw sendError;
  }

  return {
    ok: true,
    conversationId: conversation.id,
    userId: client.user.id,
    requestedUserId: userId,
    sent: { text: message },
    replies,
    timedOut: timedOut && replies.length === 0,
  };
}
