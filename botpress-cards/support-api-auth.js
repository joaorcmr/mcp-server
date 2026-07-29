/**
 * support-api — autenticação JWT (substitui a apikey).
 *
 * Contrato da API (verificado em Omni/backend/support-api):
 *   POST /auth/login    body { username, password }   -> 200 { accessToken, refreshToken, tokenType, expiresIn }
 *   POST /auth/refresh  body { refreshToken }         -> 200 { mesmo shape }
 *   rotas protegidas    header Authorization: Bearer <accessToken>
 *
 * Atenção a dois detalhes que quebram silenciosamente:
 *
 *  - O campo é `username`, tudo minúsculo. A API roda ValidationPipe com
 *    `forbidNonWhitelisted: true`, então `userName` volta 400, não 401.
 *  - `expiresIn` vem em SEGUNDOS (padrão 900 = 15 min). O refresh token dura 8h.
 *
 * Por que cachear e não logar a cada chamada: POST /auth/login está limitado a
 * 40 requisições/hora (AuthThrottlerGuard) e falhas seguidas bloqueiam a conta
 * (LockoutPolicyService). Renovando ~2 min antes do vencimento, o bot faz no
 * máximo ~4 logins/hora — e, usando o refresh token, bem menos que isso.
 *
 * ---------------------------------------------------------------------------
 * Pré-requisitos no Studio
 * ---------------------------------------------------------------------------
 *
 * 1) Configuration Variables (Bot Settings) — lidas aqui via `env.*`:
 *      SUPPORT_API_URL       ex.: https://support-api.seu-dominio.com  (sem barra final)
 *      SUPPORT_API_USERNAME  usuário de serviço do bot
 *      SUPPORT_API_PASSWORD  senha do usuário de serviço
 *
 * 2) Bot Variables (painel Variables, escopo "Bot" — persistem entre conversas,
 *    que é o que faz o cache do token valer para todo mundo):
 *      supportAccessToken    string
 *      supportRefreshToken   string
 *      supportAccessExpMs    number
 *      supportRefreshExpMs   number
 *
 * ---------------------------------------------------------------------------
 * Como usar
 * ---------------------------------------------------------------------------
 *
 * Cada card "Execute Code" do Botpress roda no seu próprio escopo, então
 * funções declaradas em um card NÃO enxergam o outro. Duas opções:
 *
 *   (A) Recomendado: cole este bloco inteiro no MESMO card que faz a chamada e
 *       troque a chamada antiga por `supportApiFetch(...)` — ver exemplo no fim.
 *
 *   (B) Se seus cards de chamada já existem e você só quer o header: cole este
 *       bloco em um card anterior e termine com
 *         `workflow.supportToken = await getSupportAccessToken()`
 *       usando depois `Authorization: 'Bearer ' + workflow.supportToken`.
 *       Perde-se o retry automático em 401 — aceitável se o card seguinte roda
 *       logo em seguida.
 */

const SUPPORT_API_URL = String(env.SUPPORT_API_URL || '').replace(/\/+$/, '')

/** Renova este tanto de tempo ANTES do vencimento, para não usar token na virada. */
const RENEW_SKEW_MS = 2 * 60 * 1000

/** Fallback do JWT_REFRESH_TTL padrão da API, caso o `exp` não seja legível. */
const DEFAULT_REFRESH_TTL_MS = 8 * 60 * 60 * 1000

/**
 * Lê o `exp` de um JWT (em ms) sem validar assinatura — serve só para saber
 * quando trocar o token; quem valida de verdade é a API. Se falhar, o chamador
 * cai no fallback baseado em `expiresIn`.
 */
function jwtExpMs(token) {
  try {
    const payload = String(token).split('.')[1]
    const json = Buffer.from(payload, 'base64').toString('utf8')
    const exp = JSON.parse(json).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch (e) {
    return null
  }
}

function storeTokens(tokens) {
  const now = Date.now()

  bot.supportAccessToken = tokens.accessToken
  bot.supportRefreshToken = tokens.refreshToken
  bot.supportAccessExpMs =
    jwtExpMs(tokens.accessToken) || now + Number(tokens.expiresIn || 0) * 1000
  bot.supportRefreshExpMs =
    jwtExpMs(tokens.refreshToken) || now + DEFAULT_REFRESH_TTL_MS
}

function clearTokens() {
  bot.supportAccessToken = null
  bot.supportRefreshToken = null
  bot.supportAccessExpMs = 0
  bot.supportRefreshExpMs = 0
}

/** POST JSON sem autenticação — usado só pelas rotas /auth/*. */
async function postAuthJson(path, body) {
  const response = await fetch(SUPPORT_API_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    // A API pode responder HTML em erro de gateway; o status já basta.
  }

  return { ok: response.ok, status: response.status, data: data }
}

async function login() {
  // NUNCA logar a senha nem o token — só o desfecho.
  const result = await postAuthJson('/auth/login', {
    username: env.SUPPORT_API_USERNAME,
    password: env.SUPPORT_API_PASSWORD,
  })

  if (!result.ok) {
    clearTokens()

    // 429 + ACCOUNT_LOCKED = conta travada por tentativas (tem `retryAfter`).
    // 429 sem esse código = throttle de 40/h da própria rota de login.
    // 400 = body rejeitado pelo whitelist (confira o nome do campo `username`).
    console.error('[support-api] login falhou', {
      status: result.status,
      error: result.data && result.data.error,
      retryAfter: result.data && result.data.retryAfter,
    })

    throw new Error(
      '[support-api] login falhou: ' +
        result.status +
        ' ' +
        ((result.data && result.data.error) || ''),
    )
  }

  storeTokens(result.data)
  console.log('[support-api] login OK', { expiresIn: result.data.expiresIn })
}

/** Tenta renovar pelo refresh token. Retorna false para o chamador cair no login. */
async function refreshTokens() {
  const result = await postAuthJson('/auth/refresh', {
    refreshToken: bot.supportRefreshToken,
  })

  if (!result.ok) {
    console.warn('[support-api] refresh falhou, indo de login', {
      status: result.status,
      error: result.data && result.data.error,
    })
    clearTokens()
    return false
  }

  storeTokens(result.data)
  console.log('[support-api] token renovado via refresh')
  return true
}

/**
 * Devolve um access token válido, na ordem mais barata: cache -> refresh -> login.
 */
async function getSupportAccessToken() {
  const now = Date.now()

  if (bot.supportAccessToken && bot.supportAccessExpMs - now > RENEW_SKEW_MS) {
    return bot.supportAccessToken
  }

  if (bot.supportRefreshToken && bot.supportRefreshExpMs - now > RENEW_SKEW_MS) {
    if (await refreshTokens()) {
      return bot.supportAccessToken
    }
  }

  await login()
  return bot.supportAccessToken
}

/**
 * Chamada autenticada à support-api. Substitui o `fetch` antigo que mandava a
 * apikey no header.
 *
 * Em 401 (secret rotacionado, relógio fora de sincronia, token invalidado)
 * descarta o cache e tenta UMA vez — sem laço, para não empurrar a conta contra
 * a política de lockout.
 */
async function supportApiFetch(path, options, _alreadyRetried) {
  const opts = options || {}
  const token = await getSupportAccessToken()

  const response = await fetch(SUPPORT_API_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      Authorization: 'Bearer ' + token,
    },
  })

  if (response.status === 401 && !_alreadyRetried) {
    console.warn('[support-api] 401 com token em cache, reautenticando', { path })
    clearTokens()
    return supportApiFetch(path, opts, true)
  }

  return response
}

// ---------------------------------------------------------------------------
// Exemplo de uso — troque pelo endpoint que este card chamava com a apikey.
// As rotas hoje protegidas por JwtAuthGuard são /users e /schedules.
// ---------------------------------------------------------------------------

try {
  const response = await supportApiFetch('/schedules', { method: 'GET' })

  if (!response.ok) {
    console.error('[support-api] chamada falhou', { status: response.status })
    workflow.supportApiError = true
  } else {
    workflow.supportApiData = await response.json()
    workflow.supportApiError = false
  }
} catch (e) {
  // Falha de autenticação (login/refresh) chega aqui.
  console.error('[support-api] erro na chamada', { message: e.message })
  workflow.supportApiError = true
}
