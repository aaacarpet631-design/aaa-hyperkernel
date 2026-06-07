/*
 * AAA Nemotron Transport — the production bridge from the adapter to the
 * server-side nemotron proxy.
 *
 * The NVIDIA adapter calls an injected transport; this is the real one. It maps a
 * router call into the proxy's request shape ({ system, messages, model,
 * max_tokens }), POSTs it to the same-origin / cloud proxy (which holds
 * NVIDIA_API_KEY server-side), and parses { ok, text, content, usage } back into
 * the adapter's result. It NEVER holds or sends an API key.
 *
 * Off by default: until install() is called with a configured endpoint, the
 * global transport stays unset and the adapter uses its deterministic offline
 * stub — so dev/CI never touch the network. build()/parse() are pure + tested;
 * send() is the function the adapter invokes once installed.
 *
 * The chat proxy serves text models (Instruct / Base). Reward scoring needs a
 * separate scoring endpoint; absent one, reward calls report unsupported and the
 * router falls back to a neutral score — never a fabricated one.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }

  const SYSTEM = {
    draft_customer_message: 'You draft a SUGGESTED customer message for a carpet-cleaning business. Concise, friendly, professional. This is a draft for the owner to review and edit — never promise pricing, discounts, or commitments.',
    owner_briefing_explanation: 'You explain a business owner briefing clearly and concisely. Advisory only; do not invent numbers.',
    executive_council_reasoning: 'You give concise advisory reasoning for an executive review. You do NOT make the decision.',
    synthetic_training_case: 'You generate a clearly-synthetic internal training example. Never use or imply real customer data.',
    scenario_generation: 'You generate an internal what-if planning scenario. Internal use only; not customer-facing.'
  };

  const state = { endpoint: null, rewardEndpoint: null, fetch: null, maxTokens: 512, installed: false };

  function endpoint() { return state.endpoint || (cfg().proxyUrl) || null; }
  function fetcher() { return state.fetch || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null); }

  const Transport = {
    /** Pure: router/adapter call → proxy request body. */
    build(call) {
      const c = call || {};
      const sys = SYSTEM[c.taskType] || 'You are an advisory assistant for a carpet-cleaning business. Output is advisory only.';
      const userContent = typeof c.input === 'string' ? c.input : JSON.stringify(c.input == null ? '' : c.input);
      return { system: sys, messages: [{ role: 'user', content: userContent }], model: c.modelId || null, max_tokens: state.maxTokens };
    },

    /** Pure: proxy response → adapter result. */
    parse(res, variant) {
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'PROXY_ERROR' };
      if (variant === 'reward') { const score = res.score != null ? Number(res.score) : null; return score == null ? { ok: false, error: 'NO_SCORE' } : { ok: true, score: score, usage: res.usage || null }; }
      const text = res.text != null ? res.text : (res.content != null ? res.content : null);
      if (text == null) return { ok: false, error: 'NO_TEXT' };
      return { ok: true, text: String(text), usage: res.usage || null };
    },

    /** The function the adapter invokes once installed. Never throws upstream. */
    async send(call) {
      const c = call || {};
      const f = fetcher();
      if (!f) return { ok: false, error: 'NO_FETCH' };
      try {
        if (c.variant === 'reward') {
          if (!state.rewardEndpoint) return { ok: false, error: 'REWARD_NOT_SUPPORTED' };
          const r = await f(state.rewardEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: c.modelId, input: c.input }) });
          const j = await r.json();
          return this.parse(j, 'reward');
        }
        const url = endpoint();
        if (!url) return { ok: false, error: 'NO_ENDPOINT' };
        const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.build(c)) });
        const j = await r.json();
        return this.parse(j, c.variant);
      } catch (e) { return { ok: false, error: 'TRANSPORT_FAILED', detail: String((e && e.message) || e) }; }
    },

    isConfigured() { return !!endpoint(); },
    status() { return { installed: !!state.installed, endpoint: endpoint(), rewardEndpoint: state.rewardEndpoint, mode: state.installed ? 'live' : 'stub' }; },

    /** Install as the global adapter transport. Off until called. */
    install(opts) {
      const o = opts || {};
      state.endpoint = o.endpoint || state.endpoint || (cfg().proxyUrl) || null;
      state.rewardEndpoint = o.rewardEndpoint || state.rewardEndpoint || null;
      if (o.fetch) state.fetch = o.fetch;
      if (o.maxTokens) state.maxTokens = o.maxTokens;
      if (!state.endpoint && !o.force) return { ok: false, error: 'NO_ENDPOINT', note: 'Set proxyUrl (e.g. /api/nemotron) before installing the live transport.' };
      state.installed = true;
      global.AAA_MODEL_TRANSPORT = (call) => Transport.send(call);
      return { ok: true, endpoint: state.endpoint, rewardEndpoint: state.rewardEndpoint };
    },
    uninstall() { state.installed = false; if (global.AAA_MODEL_TRANSPORT) try { delete global.AAA_MODEL_TRANSPORT; } catch (_) { global.AAA_MODEL_TRANSPORT = null; } return { ok: true }; }
  };

  global.AAA_NEMOTRON_TRANSPORT = Transport;
})(typeof window !== 'undefined' ? window : this);
