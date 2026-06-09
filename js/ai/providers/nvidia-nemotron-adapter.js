/*
 * AAA NVIDIA Nemotron Adapter — the ONLY place a Nemotron call is shaped.
 *
 * Implements the provider-neutral adapter interface the Governed Model Router
 * consumes:
 *     { provider, supports(modelKey), async invoke(req) -> result }
 *
 * It NEVER holds an API key and NEVER calls NVIDIA / Hugging Face directly. The
 * real call goes through an injected transport — in production a same-origin
 * server proxy (netlify/functions/nemotron) that holds NVIDIA_API_KEY server-side;
 * in tests/CI a deterministic stub, so no live credentials are ever required.
 * If no transport is configured, it returns a deterministic offline stub (and the
 * router still treats a real failure as "unavailable" → fallback).
 *
 * Reward variant returns a structured score in [0,1]; Instruct/Base return text.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  // Small deterministic hash → used for reproducible stub outputs (NOT security).
  function hash32(s) { let h = 0x811c9dc5; const str = typeof s === 'string' ? s : JSON.stringify(s == null ? '' : s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function shortHash(s) { return ('0000000' + hash32(s).toString(16)).slice(-8); }

  function stubResult(req, startedAt) {
    const h = shortHash(String(req.modelId) + '|' + String(req.taskType) + '|' + JSON.stringify(req.input == null ? '' : req.input));
    if (req.variant === 'reward') {
      const score = (hash32('reward|' + h) % 1000) / 1000;          // deterministic 0..1
      return { ok: true, kind: 'score', score: Math.round(score * 1000) / 1000, raw: { stub: true, hash: h }, usage: { stub: true }, latencyMs: Math.max(1, now() - startedAt) };
    }
    const text = '[nemotron-' + (req.variant || 'instruct') + ' stub:' + h + '] advisory ' + req.taskType + ' — deterministic offline output (no live model configured).';
    return { ok: true, kind: 'text', text: text, raw: { stub: true, hash: h }, usage: { stub: true }, latencyMs: Math.max(1, now() - startedAt) };
  }

  function normalize(req, res, latencyMs) {
    if (req.variant === 'reward') {
      const score = res.score != null ? Number(res.score) : (res.reward != null ? Number(res.reward) : null);
      if (score == null || !isFinite(score)) return { ok: false, error: 'BAD_REWARD_RESPONSE', latencyMs: latencyMs };
      return { ok: true, kind: 'score', score: Math.max(0, Math.min(1, score)), raw: res, usage: res.usage || null, latencyMs: latencyMs };
    }
    const text = res.text != null ? res.text : (res.content != null ? res.content : (res.output != null ? res.output : null));
    if (text == null) return { ok: false, error: 'BAD_TEXT_RESPONSE', latencyMs: latencyMs };
    return { ok: true, kind: 'text', text: String(text), raw: res, usage: res.usage || null, latencyMs: latencyMs };
  }

  const Adapter = {
    provider: 'nvidia',
    /** Does this adapter handle the given model key? */
    supports(modelKey) { return typeof modelKey === 'string' && modelKey.indexOf('nvidia.') === 0; },

    /**
     * Invoke the model. req: { modelKey, modelId, runtime, taskType, variant,
     * input, transport? }. Returns a normalized result; never throws.
     */
    async invoke(req) {
      const r = req || {};
      const startedAt = now();
      if (!r.modelId) return { ok: false, error: 'NO_MODEL_ID', latencyMs: 0 };
      // Transport = the server proxy (prod) or an injected stub (tests). Never a key here.
      const transport = r.transport || global.AAA_MODEL_TRANSPORT || null;
      if (!transport) {
        if (flag('modelAllowOfflineStub', true)) return stubResult(r, startedAt);  // CI / offline-safe default
        return { ok: false, error: 'PROVIDER_UNAVAILABLE', detail: 'No transport configured', latencyMs: Math.max(1, now() - startedAt) };
      }
      try {
        const res = await transport({ provider: 'nvidia', modelKey: r.modelKey, modelId: r.modelId, runtime: r.runtime, taskType: r.taskType, variant: r.variant, input: r.input });
        if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'PROVIDER_ERROR', latencyMs: Math.max(1, now() - startedAt) };
        return normalize(r, res, Math.max(1, now() - startedAt));
      } catch (e) {
        return { ok: false, error: 'PROVIDER_UNAVAILABLE', detail: String((e && e.message) || e), latencyMs: Math.max(1, now() - startedAt) };
      }
    }
  };

  // Register into the shared adapter list the router scans (load-order independent).
  global.AAA_MODEL_ADAPTERS = global.AAA_MODEL_ADAPTERS || [];
  if (global.AAA_MODEL_ADAPTERS.indexOf(Adapter) === -1) global.AAA_MODEL_ADAPTERS.push(Adapter);
  global.AAA_NVIDIA_ADAPTER = Adapter;
})(typeof window !== 'undefined' ? window : this);
