/* GPT-6 Astra adapter for the app's existing message/decision contract.
 * Docs: https://developers.openai.com/api/docs/guides/latest-model
 * Uses Responses, including reasoning budget, image inputs and strict JSON.
 */
export const MODEL = 'gpt-6-astra';
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const API_URL = 'https://api.openai.com/v1/responses';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export class OpenAIError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, apikey',
    'access-control-allow-methods': 'POST, OPTIONS'
  } });
}

export function errorResponse(err) {
  // Never return raw provider errors, tokens, request content, or key values.
  return json({ ok: false, error: err instanceof OpenAIError ? err.code : 'PROVIDER_UNAVAILABLE' },
    err instanceof OpenAIError ? err.status : 502);
}

export async function readBody(req) {
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) throw new OpenAIError('REQUEST_TOO_LARGE', 413);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new OpenAIError('REQUEST_TOO_LARGE', 413);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new OpenAIError('INVALID_JSON'); }
}

function textBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every(b => b && b.type === 'text' && typeof b.text === 'string')) {
    throw new OpenAIError('UNSUPPORTED_CONTENT');
  }
  return value.map(b => b.text).join('\n');
}

function message(m) {
  if (!m || !['user', 'assistant'].includes(m.role)) throw new OpenAIError('INVALID_MESSAGE_ROLE');
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  if (!Array.isArray(m.content) || !m.content.length) throw new OpenAIError('INVALID_CONTENT');
  if (m.role === 'assistant') return { role: m.role, content: textBlocks(m.content) };
  return { role: m.role, content: m.content.map(b => {
    if (b && b.type === 'text' && typeof b.text === 'string') return { type: 'input_text', text: b.text };
    const s = b && b.source;
    if (b && b.type === 'image' && s && s.type === 'base64' &&
        ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(s.media_type) &&
        typeof s.data === 'string' && s.data.length > 0 && s.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s.data)) {
      return { type: 'input_image', image_url: 'data:' + s.media_type + ';base64,' + s.data, detail: 'auto' };
    }
    throw new OpenAIError('UNSUPPORTED_CONTENT');
  }) };
}

// Strict output requires every property. Optional fields become nullable;
// existing required fields and constraints retain their meaning.
export function strictSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new OpenAIError('INVALID_SCHEMA');
  const out = { ...schema };
  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties && schema.additionalProperties !== false) throw new OpenAIError('UNSUPPORTED_SCHEMA');
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      const child = strictSchema(value);
      Object.defineProperty(out.properties, key, { enumerable: true, configurable: true, writable: true,
        value: (schema.required || []).includes(key) ? child : { anyOf: [child, { type: 'null' }] } });
    }
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (schema.items) out.items = strictSchema(schema.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) out[key] = schema[key].map(strictSchema);
  for (const key of ['$defs', 'definitions']) if (schema[key]) {
    out[key] = Object.fromEntries(Object.entries(schema[key]).map(([k, v]) => [k, strictSchema(v)]));
  }
  return out;
}

export function toRequest(body, env = process.env) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 64) throw new OpenAIError('INVALID_MESSAGES');
  if (body.model && body.model !== MODEL) throw new OpenAIError('UNSUPPORTED_MODEL');
  if (body.tools || body.tool_choice || body.stream) throw new OpenAIError('UNSUPPORTED_REQUEST');
  const effort = env.OPENAI_REASONING_EFFORT || 'medium';
  // Responses counts reasoning + visible output together; do not reuse the
  // old 700-token visible-output allowance as the whole reasoning budget.
  const budget = Number(env.OPENAI_MAX_OUTPUT_TOKENS || 8192);
  if (!EFFORTS.includes(effort) || !Number.isInteger(budget) || budget < 1024 || budget > 32768) {
    throw new OpenAIError('INVALID_OPENAI_CONFIG', 503);
  }
  const payload = { model: MODEL, input: body.messages.map(message), reasoning: { effort }, max_output_tokens: budget, store: false };
  if (body.system != null) payload.instructions = textBlocks(body.system);
  if (body.output_config) {
    const format = body.output_config.format;
    if (!format || format.type !== 'json_schema' || !format.schema || format.schema.type !== 'object') throw new OpenAIError('INVALID_SCHEMA');
    payload.text = { format: { type: 'json_schema', name: 'aaa_response', strict: true, schema: strictSchema(format.schema) } };
  }
  return payload;
}

export function fromResponse(data) {
  if (!data || data.status !== 'completed') throw new OpenAIError(data && data.status === 'incomplete' ? 'PROVIDER_INCOMPLETE' : 'PROVIDER_FAILED', 502);
  const output = Array.isArray(data.output) ? data.output : [];
  const blocks = output.filter(o => o.type === 'message').flatMap(o => o.content || []);
  if (blocks.some(b => b.type === 'refusal')) throw new OpenAIError('PROVIDER_REFUSAL', 422);
  if (output.some(o => !['message', 'reasoning'].includes(o.type))) throw new OpenAIError('UNSUPPORTED_OUTPUT', 502);
  const text = blocks.filter(b => b.type === 'output_text' && typeof b.text === 'string').map(b => b.text).join('');
  if (!text.trim()) throw new OpenAIError('EMPTY_OUTPUT', 502);
  return { ok: true, text, content: [{ type: 'text', text }], usage: data.usage || {},
    model: data.model || MODEL, provider: 'openai', responseId: data.id || null, stop_reason: 'end_turn' };
}

export async function callOpenAI(body, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.OPENAI_API_KEY) throw new OpenAIError('MISSING_OPENAI_API_KEY', 503);
  const payload = toRequest(body, env);
  const res = await fetchImpl(API_URL, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
  if (!res.ok) {
    const code = res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH_FAILED' :
      res.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_FAILED';
    throw new OpenAIError(code, res.status === 429 ? 429 : 502);
  }
  return fromResponse(await res.json());
}
