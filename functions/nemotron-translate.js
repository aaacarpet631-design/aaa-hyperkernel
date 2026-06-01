/*
 * nemotron-translate — pure, dependency-free translation between the app's
 * Anthropic-style proxy payload and NVIDIA's OpenAI-compatible chat API.
 *
 * The whole app speaks one request shape: { system?, messages, model?,
 * max_tokens? } and expects one response shape: { ok, text, content, usage,
 * stop_reason }. NVIDIA's hosted Nemotron endpoint is OpenAI-compatible, so
 * this module is the only place that knows the difference. Keeping it pure (no
 * network, no SDK) means every backend port (Firebase / Netlify / Supabase)
 * reuses it and it is unit-tested offline.
 */
'use strict';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
// NVFP4 build hosted on build.nvidia.com / NIM. Override per-deploy with the
// NEMOTRON_MODEL env var when NVIDIA publishes a different served name.
const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

/**
 * Convert one message's content (a plain string or Anthropic content blocks)
 * into OpenAI chat content. Text-only collapses to a string (broadest
 * support); anything with an image becomes a multimodal parts array, since
 * Nemotron-Omni accepts vision input.
 */
function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.source) {
      const s = b.source;
      const url = s.type === 'base64'
        ? 'data:' + (s.media_type || 'image/jpeg') + ';base64,' + (s.data || '')
        : (s.url || '');
      if (url) parts.push({ type: 'image_url', image_url: { url: url } });
    }
  }
  if (parts.length && parts.every((p) => p.type === 'text')) {
    return parts.map((p) => p.text).join('');
  }
  return parts;
}

/**
 * Resolve which model to actually call. Agents across the app pin Claude model
 * ids (claude-opus-4-8, claude-sonnet-4-6, …); against NVIDIA those are
 * meaningless, so any non-Nemotron request transparently falls back to the
 * configured Nemotron default. An explicit nvidia/* (or *nemotron*) id is
 * honored so callers can still target a specific served model.
 */
function resolveModel(requested, fallback) {
  const m = typeof requested === 'string' ? requested : '';
  if (/^nvidia\//i.test(m) || /nemotron/i.test(m)) return m;
  return fallback || DEFAULT_MODEL;
}

/** App payload -> NVIDIA (OpenAI chat-completions) request body. */
function toRequest(body, opts) {
  body = body || {};
  opts = opts || {};
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: String(body.system) });
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    if (!m || !m.role) continue;
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    messages.push({ role: role, content: toOpenAIContent(m.content) });
  }
  return {
    model: resolveModel(body.model, opts.defaultModel),
    messages: messages,
    max_tokens: body.max_tokens || 1024,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.6,
  };
}

/**
 * NVIDIA (OpenAI chat-completions) response -> the app's { ok, text, content,
 * usage, stop_reason } shape. Reasoning models may split chain-of-thought into
 * reasoning_content; we surface only the final answer as `text` (so the
 * existing JSON parsers keep working) and pass reasoning through separately.
 */
function fromResponse(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = (choice && choice.message) ? choice.message : {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const u = (data && data.usage) ? data.usage : {};
  const out = {
    ok: true,
    text: text,
    content: text ? [{ type: 'text', text: text }] : [],
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
    stop_reason: choice ? choice.finish_reason : undefined,
  };
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    out.reasoning = msg.reasoning_content;
  }
  return out;
}

module.exports = { NVIDIA_URL, DEFAULT_MODEL, toOpenAIContent, resolveModel, toRequest, fromResponse };
