/* Server-owned authorization shared by private app APIs. Browser role flags
 * never grant access. Existing OpenAI deployment settings remain compatible.
 */
import { authorizeOpenAI } from './openai-auth.mjs';
import { OpenAIError, json, errorResponse } from './openai.mjs';
import { consumeBudget, validateJson } from './request-policy.mjs';

export function appEnv() {
  return new Proxy({}, { get: (_, key) => globalThis.Netlify?.env?.get(key) ?? process.env[key] });
}

export async function authorizeApp(req, { env = appEnv(), fetchImpl = fetch } = {}) {
  const authEnv = new Proxy(env, { get: (source, key) => {
    if (key === 'OPENAI_ALLOWED_USER_IDS') return source.APP_ALLOWED_USER_IDS ?? source.OPENAI_ALLOWED_USER_IDS;
    if (key === 'OPENAI_AUTH_PROVIDER') return source.APP_AUTH_PROVIDER ?? source.OPENAI_AUTH_PROVIDER;
    return source[key];
  } });
  try { return await authorizeOpenAI(req, { env: authEnv, fetchImpl }); }
  catch (err) {
    if (err.code === 'OPENAI_AUTH_NOT_CONFIGURED') throw new OpenAIError('APP_AUTH_NOT_CONFIGURED', 503);
    if (err.code === 'OPENAI_ACCESS_DENIED') throw new OpenAIError('APP_ACCESS_DENIED', 403);
    throw err;
  }
}

export async function boundedBody(req, limit = 5 * 1024 * 1024) {
  if (Number(req.headers.get('content-length')) > limit) throw new OpenAIError('REQUEST_TOO_LARGE', 413);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new OpenAIError('REQUEST_TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function defaultBudget(userId) {
  const { getStore } = await import('@netlify/blobs');
  await consumeBudget(getStore({ name: 'private-api-budget', consistency: 'strong' }), userId);
}

export function withAppAuth(handler, { authorize = authorizeApp, budget = defaultBudget, methods = ['GET', 'POST'] } = {}) {
  return async (req, context) => {
    if (req.method === 'OPTIONS') return json({ ok: true });
    if (!methods.includes(req.method)) return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    try {
      const userId = await authorize(req);
      if (req.method === 'POST') {
        const bytes = await boundedBody(req);
        if ((req.headers.get('content-type') || '').includes('application/json')) {
          let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new OpenAIError('INVALID_JSON'); }
          validateJson(body);
        }
        req = new Request(req, { body: bytes });
      }
      await budget(userId);
      const response = await handler(req, { ...context, userId });
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('x-frame-options', 'DENY');
      return response;
    } catch (err) {
      const response = errorResponse(err);
      if (err.code === 'RATE_LIMITED') response.headers.set('retry-after', '60');
      return response;
    }
  };
}
