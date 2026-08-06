#!/usr/bin/env node
/**
 * support-api-auth — CLI de autenticação da support-api (JWT).
 *
 * Substitui o Basic Auth que o bot usava antes do pentest de 2026. Guarda o par
 * de tokens em disco (~/.omni/support-api-<env>.json) e faz refresh sozinho, de
 * modo que `token` sempre devolve um access token válido para colar num curl.
 *
 * Uso:
 *   node scripts/support-api-auth.mjs login            # user/senha -> par de tokens
 *   node scripts/support-api-auth.mjs refresh          # roda o refresh token
 *   node scripts/support-api-auth.mjs token            # imprime SÓ o access token (refresca se preciso)
 *   node scripts/support-api-auth.mjs whoami           # decodifica o access token guardado
 *   node scripts/support-api-auth.mjs call POST /users/cpf '{"cpf":"..."}'
 *
 * Variáveis de ambiente:
 *   SUPPORT_API_URL       base URL (default: stg)
 *   SUPPORT_API_USER      username
 *   SUPPORT_API_PASSWORD  senha
 *   SUPPORT_API_ENV       rótulo do arquivo de cache (default: stg)
 *
 * Exemplo:
 *   export SUPPORT_API_USER=omni_stg_user SUPPORT_API_PASSWORD=omni_stg_user
 *   node scripts/support-api-auth.mjs login
 *   curl -H "Authorization: Bearer $(node scripts/support-api-auth.mjs token)" \
 *        -H 'Content-Type: application/json' -d '{"cpf":"12345678900"}' \
 *        https://support-api-stg-116932645397.southamerica-east1.run.app/users/cpf
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = (
  process.env.SUPPORT_API_URL ||
  'https://support-api-stg-116932645397.southamerica-east1.run.app'
).replace(/\/+$/, '');

const ENV_LABEL = process.env.SUPPORT_API_ENV || 'stg';
const CACHE_FILE = join(homedir(), '.omni', `support-api-${ENV_LABEL}.json`);

/**
 * Renova antes da hora: o access token vale 15min, e a margem evita que uma
 * chamada saia com um token que expira no meio do caminho.
 */
const REFRESH_SKEW_MS = 60_000;

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const post = async (path, body) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      `${path} -> ${response.status} ${payload.error || ''} ${payload.message || text}`.trim(),
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const decodeJwt = (token) => {
  const [, payload] = token.split('.');
  if (!payload) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
};

const readCache = async () => {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const writeCache = async (tokens) => {
  const accessExp = decodeJwt(tokens.accessToken)?.exp;
  const refreshExp = decodeJwt(tokens.refreshToken)?.exp;

  const cache = {
    ...tokens,
    baseUrl: BASE_URL,
    accessExpiresAt: accessExp ? accessExp * 1000 : Date.now() + tokens.expiresIn * 1000,
    refreshExpiresAt: refreshExp ? refreshExp * 1000 : null,
    savedAt: new Date().toISOString(),
  };

  await mkdir(dirname(CACHE_FILE), { recursive: true });
  // 0600: o refresh token vale 8h, trate o arquivo como credencial.
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });

  return cache;
};

const login = async () => {
  const username = process.env.SUPPORT_API_USER;
  const password = process.env.SUPPORT_API_PASSWORD;

  if (!username || !password) {
    fail('defina SUPPORT_API_USER e SUPPORT_API_PASSWORD');
  }

  // POST /auth/login: 40 tentativas/hora por IP, e 5 senhas erradas seguidas
  // bloqueiam a conta com backoff progressivo (1min -> 15min).
  const tokens = await post('/auth/login', { username, password });

  return writeCache(tokens);
};

const refresh = async () => {
  const cache = await readCache();

  if (!cache?.refreshToken) {
    fail(`sem refresh token em ${CACHE_FILE} — rode "login" primeiro`);
  }

  // O refresh devolve um par novo (access + refresh), então renovar de forma
  // recorrente mantém a sessão viva sem voltar a mandar user/senha.
  const tokens = await post('/auth/refresh', { refreshToken: cache.refreshToken });

  return writeCache(tokens);
};

/** Access token válido, renovando ou relogando conforme a necessidade. */
const getAccessToken = async () => {
  const cache = await readCache();

  if (cache?.accessToken && cache.accessExpiresAt - REFRESH_SKEW_MS > Date.now()) {
    return cache.accessToken;
  }

  if (cache?.refreshToken) {
    try {
      return (await refresh()).accessToken;
    } catch (error) {
      if (error.status !== 401) throw error;
      // Refresh expirado (8h) ou credencial removida: cai para o login.
    }
  }

  return (await login()).accessToken;
};

const summarize = (cache) => {
  const claims = decodeJwt(cache.accessToken);
  console.log(
    JSON.stringify(
      {
        baseUrl: cache.baseUrl,
        username: claims?.username,
        sub: claims?.sub,
        accessExpiresAt: new Date(cache.accessExpiresAt).toISOString(),
        refreshExpiresAt: cache.refreshExpiresAt
          ? new Date(cache.refreshExpiresAt).toISOString()
          : null,
        cacheFile: CACHE_FILE,
      },
      null,
      2,
    ),
  );
};

const call = async (method, path, body) => {
  const token = await getAccessToken();

  const response = await fetch(`${BASE_URL}${path}`, {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });

  const text = await response.text();
  console.error(`→ ${method.toUpperCase()} ${path} [${response.status}]`);
  console.log(text);

  if (!response.ok) process.exit(1);
};

const [command = 'token', ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'login':
      summarize(await login());
      break;
    case 'refresh':
      summarize(await refresh());
      break;
    case 'token':
      console.log(await getAccessToken());
      break;
    case 'whoami': {
      const cache = await readCache();
      if (!cache) fail(`nada em cache em ${CACHE_FILE}`);
      summarize(cache);
      break;
    }
    case 'call': {
      const [method, path, body] = args;
      if (!method || !path) fail('uso: call <METHOD> <path> [jsonBody]');
      await call(method, path, body);
      break;
    }
    default:
      fail(`comando desconhecido: ${command} (login|refresh|token|whoami|call)`);
  }
} catch (error) {
  fail(error.message);
}
