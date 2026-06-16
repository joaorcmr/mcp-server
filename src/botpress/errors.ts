/**
 * Estrutura de erro padronizada que as tools retornam ao Claude Code.
 * O objetivo é transformar erros crus do SDK/HTTP em algo legível e acionável.
 */
export interface FormattedError {
  ok: false;
  error: {
    message: string;
    type?: string;
    code?: string | number;
    details?: unknown;
  };
}

/**
 * Converte qualquer erro (do SDK do Botpress, de rede, ou genérico)
 * em uma `FormattedError` consistente.
 */
export function formatBotpressError(err: unknown): FormattedError {
  // Erros do SDK do Botpress costumam expor code/type/message.
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    const message =
      typeof anyErr.message === "string" ? anyErr.message : "Erro ao chamar a API do Botpress.";

    return {
      ok: false,
      error: {
        message,
        type: typeof anyErr.type === "string" ? anyErr.type : anyErr.name as string | undefined,
        code: (anyErr.code ?? anyErr.status) as string | number | undefined,
        // Inclui o corpo da resposta quando disponível, ajudando a depurar.
        details: anyErr.body ?? anyErr.response ?? undefined,
      },
    };
  }

  return {
    ok: false,
    error: { message: String(err) },
  };
}
