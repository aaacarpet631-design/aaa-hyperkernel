/*
 * AAA Content Safety — a guardrail over NVIDIA's nemotron-3-content-safety
 * classifier. Screens text (a customer/field input, or an AI-generated message
 * about to go to a customer) and returns a structured safety verdict.
 *
 * SAFETY (hard rule, by construction): this module only CLASSIFIES. It never
 * blocks, edits, sends, or stores anything on its own — callers decide what to
 * do with a verdict. Nothing here changes app behavior until a caller wires it
 * into a flow.
 *
 * Honest by construction: the classifier runs server-side through the Nemotron
 * proxy (AAA_CLOUD.callProxy → nemotronProxyUrl), so the NVIDIA key never
 * reaches the browser. The call is routed to the Nemotron endpoint explicitly,
 * independent of aiProvider, so it works even when the agents run on Claude.
 * With no proxy configured it returns { ok:false, error:'AI_NOT_CONFIGURED' }
 * — it never guesses a verdict.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function cloud() { return global.AAA_CLOUD; }

  const MODEL = 'nvidia/nemotron-3-content-safety';
  // NVIDIA's recommended sampling for the classifier (low temp = stable verdict).
  const TEMPERATURE = 0.2;
  const TOP_P = 0.7;
  const MAX_TOKENS = 512;

  function lc(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

  function tryJson(s) {
    try { return JSON.parse(s); } catch (_) {}
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
    return null;
  }

  // Normalize a categories value (string "S1, S2" | array | object) to a list.
  function normCats(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'object') return Object.keys(v).filter((k) => v[k]);
    return String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  }

  /**
   * Parse the classifier's reply into a stable verdict. Tolerant of the two
   * shapes these models emit: a JSON object ({ "User Safety": "unsafe",
   * "Safety Categories": "..." }) or a plain Llama-Guard-style "unsafe\nS2".
   * `safe` is null (unknown) — never a false "safe" — when the reply can't be
   * read, so callers can fail closed if they choose.
   */
  function parseVerdict(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return { verdict: 'unknown', safe: null, categories: [], raw: s };

    const obj = tryJson(s);
    if (obj && typeof obj === 'object') {
      const userSafety = lc(obj['User Safety'] || obj.user_safety || obj.userSafety);
      const respSafety = lc(obj['Response Safety'] || obj.response_safety || obj.responseSafety);
      const known = userSafety || respSafety;
      const unsafe = userSafety === 'unsafe' || respSafety === 'unsafe';
      return {
        verdict: !known ? 'unknown' : (unsafe ? 'unsafe' : 'safe'),
        safe: !known ? null : !unsafe,
        userSafety: userSafety || null,
        responseSafety: respSafety || null,
        categories: normCats(obj['Safety Categories'] || obj.safety_categories || obj.categories),
        raw: obj
      };
    }

    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const head = lc(lines[0]);
    if (head === 'unsafe') return { verdict: 'unsafe', safe: false, categories: normCats(lines.slice(1).join(',')), raw: s };
    if (head === 'safe') return { verdict: 'safe', safe: true, categories: [], raw: s };
    return { verdict: 'unknown', safe: null, categories: [], raw: s };
  }

  const Safety = {
    isReady() {
      return !!(cloud() && cloud().isConfigured && cloud().isConfigured() && cfg().nemotronProxyUrl);
    },

    /** Low-level: classify a prepared message list. Used by check/checkResponse. */
    async _classify(messages, opts) {
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      const o = opts || {};
      const payload = {
        agent: 'content_safety', model: MODEL,
        max_tokens: o.max_tokens || MAX_TOKENS,
        temperature: typeof o.temperature === 'number' ? o.temperature : TEMPERATURE,
        top_p: typeof o.top_p === 'number' ? o.top_p : TOP_P,
        messages: messages
      };
      // Optional category taxonomy (NVIDIA's request_categories chat-template arg).
      if (o.categories) payload.chat_template_kwargs = { request_categories: o.categories };
      const res = await cloud().callProxy(payload, cfg().nemotronProxyUrl);
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'SAFETY_FAILED', detail: res && res.detail };
      const v = parseVerdict(res.text || '');
      return {
        ok: true,
        safe: v.safe,
        flagged: v.safe === false,
        verdict: v.verdict,
        categories: v.categories,
        userSafety: v.userSafety,
        responseSafety: v.responseSafety,
        raw: v.raw,
        usage: res.usage
      };
    },

    /** Screen a single piece of text (a user/customer input or field note). */
    async check(text, opts) {
      const s = String(text == null ? '' : text).trim();
      if (!s) return { ok: false, error: 'EMPTY_TEXT' };
      return this._classify([{ role: 'user', content: s }], opts);
    },

    /**
     * Screen an AI-generated response in the context of the prompt that
     * produced it — the right check before sending an agent's message to a
     * customer. Returns the same verdict shape (responseSafety populated).
     */
    async checkResponse(userText, assistantText, opts) {
      const a = String(assistantText == null ? '' : assistantText).trim();
      if (!a) return { ok: false, error: 'EMPTY_TEXT' };
      return this._classify([
        { role: 'user', content: String(userText == null ? '' : userText) },
        { role: 'assistant', content: a }
      ], opts);
    }
  };

  // Expose the pure parser for tests and for callers that already have a reply.
  Safety.parseVerdict = parseVerdict;

  global.AAA_CONTENT_SAFETY = Safety;
})(typeof window !== 'undefined' ? window : this);
