/*
 * AAA Private GPU Transport — resilient bridge to the server-side GPU proxy.
 *
 * The private-GPU adapter calls this once installed. It maps a router call to the
 * app proxy shape, POSTs to the SAME-ORIGIN proxy (/api/private-gpu) which holds
 * PRIVATE_GPU_MODEL_URL / PRIVATE_GPU_MODEL_KEY server-side, and parses the reply.
 * It NEVER holds the GPU URL or key. Resilience is built in here:
 *   - per-call TIMEOUT (so a hung GPU can't block the UI),
 *   - a RETRY CAP (one quick retry on transient failure),
 *   - a CIRCUIT BREAKER (after N consecutive failures it opens and fails fast for
 *     a cooldown, then half-opens to probe recovery).
 * On any failure it returns { ok:false, error } so the router falls back and the
 * UI shows "AI model unavailable" — never fabricated output.
 *
 * Off by default: until install() runs, the adapter uses a deterministic offline
 * stub, so dev/CI never touch the network or a GPU.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const SYSTEM = {
    draft_customer_message: 'You draft a SUGGESTED customer message for a carpet-cleaning business. Concise, friendly, professional. A draft for the owner to review — never promise pricing or commitments.',
    owner_briefing_explanation: 'You explain a business owner briefing clearly and concisely. Advisory only.',
    executive_council_reasoning: 'You give concise advisory reasoning for an executive review. You do NOT make the decision.',
    scenario_generation: 'You generate an internal what-if planning scenario. Internal use only.',
    synthetic_training_case: 'You generate a clearly-synthetic internal training example. Never real customer data.'
  };

  const state = {
    endpoint: null, fetch: null, maxTokens: 512, installed: false,
    timeoutMs: 30000, retryCap: 1,
    // circuit breaker
    failThreshold: 3, cooldownMs: 30000, failures: 0, openUntil: 0, lastError: null, lastOkAt: null
  };

  function endpoint() { return state.endpoint || '/api/private-gpu'; }
  function fetcher() { return state.fetch || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null); }
  function breakerState() { if (state.openUntil && now() < state.openUntil) return 'open'; if (state.openUntil && now() >= state.openUntil) return 'half-open'; return 'closed'; }
  function onSuccess() { state.failures = 0; state.openUntil = 0; state.lastError = null; state.lastOkAt = now(); }
  function onFailure(err) { state.failures += 1; state.lastError = err; if (state.failures >= state.failThreshold) state.openUntil = now() + state.cooldownMs; }

  async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), ms); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  }

  const Transport = {
    build(call) {
      const c = call || {};
      const sys = SYSTEM[c.taskType] || 'You are an advisory assistant for a carpet-cleaning business. Output is advisory only.';
      const userContent = typeof c.input === 'string' ? c.input : JSON.stringify(c.input == null ? '' : c.input);
      return { system: sys, messages: [{ role: 'user', content: userContent }], model: c.modelId || null, max_tokens: state.maxTokens };
    },
    parse(res) {
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'PROXY_ERROR' };
      const text = res.text != null ? res.text : (res.content != null ? res.content : null);
      if (text == null) return { ok: false, error: 'NO_TEXT' };
      return { ok: true, text: String(text), usage: res.usage || null };
    },

    /** The function the adapter invokes. Breaker + timeout + retry; never throws. */
    async send(call) {
      const c = call || {};
      if (breakerState() === 'open') return { ok: false, error: 'CIRCUIT_OPEN', detail: 'GPU provider temporarily disabled after repeated failures' };
      const f = fetcher();
      if (!f) return { ok: false, error: 'NO_FETCH' };
      const body = this.build(c);
      const attempts = Math.max(1, state.retryCap + 1);
      let lastErr = 'GPU_UNAVAILABLE';
      for (let i = 0; i < attempts; i++) {
        try {
          const r = await withTimeout(f(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), state.timeoutMs);
          const j = await r.json();
          const parsed = this.parse(j);
          if (parsed.ok) { onSuccess(); return parsed; }
          lastErr = parsed.error;
        } catch (e) { lastErr = (e && e.message === 'TIMEOUT') ? 'GPU_TIMEOUT' : 'GPU_UNAVAILABLE'; }
        // half-open probe consumes its single attempt; don't retry past the cap
      }
      onFailure(lastErr);
      return { ok: false, error: lastErr };
    },

    /** Health for the Reliability Command Center. */
    health() { const st = breakerState(); return { installed: !!state.installed, endpoint: state.installed ? endpoint() : null, breaker: st, failures: state.failures, openUntil: state.openUntil || null, lastError: state.lastError, lastOkAt: state.lastOkAt, healthy: state.installed ? st !== 'open' : null }; },
    status() { return this.health(); },

    install(opts) {
      const o = opts || {};
      state.endpoint = o.endpoint || state.endpoint || '/api/private-gpu';
      if (o.fetch) state.fetch = o.fetch;
      if (o.maxTokens) state.maxTokens = o.maxTokens;
      if (o.timeoutMs) state.timeoutMs = o.timeoutMs;
      if (o.retryCap != null) state.retryCap = o.retryCap;
      if (o.failThreshold) state.failThreshold = o.failThreshold;
      if (o.cooldownMs) state.cooldownMs = o.cooldownMs;
      state.installed = true; state.failures = 0; state.openUntil = 0;
      global.AAA_PRIVATE_GPU_SEND = (call) => Transport.send(call);
      return { ok: true, endpoint: endpoint() };
    },
    uninstall() { state.installed = false; state.failures = 0; state.openUntil = 0; if (global.AAA_PRIVATE_GPU_SEND) try { delete global.AAA_PRIVATE_GPU_SEND; } catch (_) { global.AAA_PRIVATE_GPU_SEND = null; } return { ok: true }; },
    _reset() { state.failures = 0; state.openUntil = 0; state.lastError = null; }   // test hook
  };

  global.AAA_PRIVATE_GPU_TRANSPORT = Transport;
})(typeof window !== 'undefined' ? window : this);
