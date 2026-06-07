/*
 * AAA Private GPU Adapter — provider-neutral adapter for a private, OpenAI-style
 * GPU model server, behind the Governed Model Router.
 *
 * Implements the same adapter interface as the NVIDIA adapter: it handles
 * `privategpu.*` model keys and delegates the actual call to the installed
 * private-GPU transport (which talks to the server-side proxy — never the GPU
 * directly, never a key in the client). With no transport installed it returns a
 * deterministic offline stub, so CI is green without a GPU. A real failure surfaces
 * as ok:false → the router falls back → the UI shows "AI model unavailable".
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function hash32(s) { let h = 0x811c9dc5; const str = typeof s === 'string' ? s : JSON.stringify(s == null ? '' : s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function shortHash(s) { return ('0000000' + hash32(s).toString(16)).slice(-8); }

  function stub(req, startedAt) {
    const h = shortHash(String(req.modelId) + '|' + String(req.taskType) + '|' + JSON.stringify(req.input == null ? '' : req.input));
    return { ok: true, kind: 'text', text: '[private-gpu stub:' + h + '] advisory ' + req.taskType + ' — deterministic offline output (no GPU configured).', raw: { stub: true, hash: h }, usage: { stub: true }, latencyMs: Math.max(1, now() - startedAt) };
  }

  const Adapter = {
    provider: 'private_gpu',
    supports(modelKey) { return typeof modelKey === 'string' && modelKey.indexOf('privategpu.') === 0; },

    async invoke(req) {
      const r = req || {};
      const startedAt = now();
      if (!r.modelId) return { ok: false, error: 'NO_MODEL_ID', latencyMs: 0 };
      const transport = r.transport || global.AAA_PRIVATE_GPU_SEND || null;
      if (!transport) {
        if (flag('privateGpuAllowOfflineStub', true)) return stub(r, startedAt);
        return { ok: false, error: 'GPU_NOT_CONFIGURED', latencyMs: Math.max(1, now() - startedAt) };
      }
      try {
        const res = await transport({ provider: 'private_gpu', modelKey: r.modelKey, modelId: r.modelId, taskType: r.taskType, variant: r.variant, input: r.input });
        if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'GPU_UNAVAILABLE', latencyMs: Math.max(1, now() - startedAt) };
        const text = res.text != null ? res.text : (res.content != null ? res.content : null);
        if (text == null) return { ok: false, error: 'BAD_TEXT_RESPONSE', latencyMs: Math.max(1, now() - startedAt) };
        return { ok: true, kind: 'text', text: String(text), raw: res, usage: res.usage || null, latencyMs: Math.max(1, now() - startedAt) };
      } catch (e) { return { ok: false, error: 'GPU_UNAVAILABLE', detail: String((e && e.message) || e), latencyMs: Math.max(1, now() - startedAt) }; }
    }
  };

  global.AAA_MODEL_ADAPTERS = global.AAA_MODEL_ADAPTERS || [];
  if (global.AAA_MODEL_ADAPTERS.indexOf(Adapter) === -1) global.AAA_MODEL_ADAPTERS.push(Adapter);
  global.AAA_PRIVATE_GPU_ADAPTER = Adapter;
})(typeof window !== 'undefined' ? window : this);
