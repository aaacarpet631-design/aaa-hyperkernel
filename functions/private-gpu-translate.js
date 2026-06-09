/*
 * private-gpu-translate — pure, dependency-free translation between the app's
 * proxy payload ({ system?, messages, model?, max_tokens? }) and an OpenAI-style
 * /v1/chat/completions request/response, for a PRIVATE GPU model server.
 *
 * This is the only place that knows the GPU server's wire shape. It is pure (no
 * network, no SDK, no env), so the Netlify/Firebase/Supabase handlers reuse it
 * and it is unit-tested offline. The handler — not this module — holds
 * PRIVATE_GPU_MODEL_URL / PRIVATE_GPU_MODEL_KEY and does the actual fetch.
 */
'use strict';

const DEFAULT_MODEL = 'local-model';

/** App payload -> OpenAI chat-completions request body. */
function toRequest(appBody, opts) {
  const b = appBody || {};
  const o = opts || {};
  const messages = [];
  if (b.system) messages.push({ role: 'system', content: String(b.system) });
  (Array.isArray(b.messages) ? b.messages : []).forEach((m) => {
    if (!m) return;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content);
    messages.push({ role: m.role || 'user', content: content });
  });
  const model = (typeof b.model === 'string' && b.model) ? b.model : (o.defaultModel || DEFAULT_MODEL);
  const out = { model: model, messages: messages };
  const mt = Number(b.max_tokens);
  out.max_tokens = isFinite(mt) && mt > 0 ? mt : 512;
  return out;
}

/** OpenAI chat-completions response -> the app's { ok, text, content, usage }. */
function fromResponse(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = (choice && choice.message) ? choice.message : {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const u = (data && data.usage) ? data.usage : {};
  return {
    ok: true,
    text: text,
    content: text ? [{ type: 'text', text: text }] : [],
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
    stop_reason: choice ? choice.finish_reason : undefined
  };
}

/** Build the upstream URL from the configured base (no trailing slash issues). */
function endpointFor(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  return /\/v1\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions';
}

module.exports = { DEFAULT_MODEL, toRequest, fromResponse, endpointFor };
