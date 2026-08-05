/**
 * Redação de segredos.
 *
 * O JSON de conteúdo do bot carrega credenciais em claro — `settings.configVariables`
 * guarda coisas como WHATSAPP_ACCESS_TOKEN e ZENDESK_ACCESS_TOKEN, e as integrações
 * trazem apiToken/clientSecret. Como a saída destas tools vai para o contexto de um
 * LLM (e pode acabar em log ou transcript), tudo isso é redigido no momento em que
 * o conteúdo é carregado, antes de qualquer tool tocar nele.
 *
 * Mantemos o NOME da chave e o tamanho do valor: isso preserva a capacidade de
 * auditar ("a variável X está configurada?") sem expor o segredo.
 */

/** Chaves cujo valor nunca deve aparecer na saída. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|apikey|api_key|credential|authorization|private_key|signingSecret)/i;

/**
 * Objetos cujo conteúdo INTEIRO é segredo, independente do nome de cada chave.
 * `configVariables` é o cofre de variáveis de configuração do bot.
 */
const SECRET_CONTAINER_KEYS = new Set(["configVariables", "secrets"]);

function mask(value: unknown): string {
  if (typeof value === "string") {
    return `<redacted:${value.length} chars>`;
  }
  return "<redacted>";
}

function redactContainer(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? item : redactContainer(item),
    );
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = mask(inner);
    }
    return out;
  }
  return mask(value);
}

/**
 * Devolve uma cópia profunda da estrutura com os segredos mascarados.
 * Não muta a entrada.
 */
export function redactSecrets<T>(input: T): T {
  return walk(input) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walk);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};

    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_CONTAINER_KEYS.has(key)) {
        out[key] = redactContainer(inner);
        continue;
      }

      if (SECRET_KEY_PATTERN.test(key)) {
        // Preserva o campo booleano/estrutural quando não há segredo de fato.
        out[key] =
          inner === null || inner === undefined || inner === "" || inner === false
            ? inner
            : mask(inner);
        continue;
      }

      out[key] = walk(inner);
    }

    return out;
  }

  return value;
}
