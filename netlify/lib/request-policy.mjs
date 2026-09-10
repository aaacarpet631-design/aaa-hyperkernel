import { createHash } from 'node:crypto';
import { OpenAIError } from './openai.mjs';

export function validateJson(value, depth = 0) {
  if (depth > 40) throw new OpenAIError('INVALID_JSON_DEPTH');
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new OpenAIError('INVALID_JSON_KEY');
      validateJson(value[key], depth + 1);
    }
  }
}

export function validateModelRequest(body) {
  const fields = ['system', 'messages', 'model', 'max_tokens', 'output_config', 'temperature', 'top_p'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !fields.includes(k))) throw new OpenAIError('INVALID_MODEL_REQUEST');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 || body.messages.some(m => !m || !['user', 'assistant', 'system'].includes(m.role) || !(typeof m.content === 'string' || Array.isArray(m.content)))) throw new OpenAIError('INVALID_MESSAGES');
  if (body.max_tokens != null && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192)) throw new OpenAIError('INVALID_TOKEN_LIMIT');
  if (body.model != null && (typeof body.model !== 'string' || !body.model || body.model.length > 150)) throw new OpenAIError('INVALID_MODEL');
  if (body.system != null && (typeof body.system !== 'string' || body.system.length > 100000)) throw new OpenAIError('INVALID_SYSTEM');
  if (body.temperature != null && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new OpenAIError('INVALID_TEMPERATURE');
  if (body.top_p != null && (!Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)) throw new OpenAIError('INVALID_TOP_P');
  return body;
}

// Distributed per-account fixed-window budget. Strong reads + conditional
// writes prevent concurrent function instances from each granting the limit.
// One key per account bounds storage growth; no raw identity is stored.
export async function consumeBudget(store, userId, now = Date.now(), limit = 60) {
  const key = createHash('sha256').update(userId).digest('hex');
  const window = Math.floor(now / 60000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await store.getWithMetadata(key, { type: 'json' });
    const used = previous?.data.window === window ? previous.data.used : 0;
    if (used >= limit) throw new OpenAIError('RATE_LIMITED', 429);
    const result = await store.setJSON(key, { window, used: used + 1 }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new OpenAIError('RATE_LIMITED', 429);
}
