/*
 * AAA Copilot Chat Bridge — routes phase-one owner questions from HyperKernel
 * Chat to the remote copilot, and steps aside for everything else (mission
 * Slice E).
 *
 * classify(text) maps a chat message to one of the five phase-one jobs (plus
 * a quoteId when the job needs one). canHandle() is the canvas's routing
 * signal: a recognized job AND a configured remote adapter. ask() runs the
 * remote round-trip and packages the validated response as a chat card
 * ({ type:'copilot_contract', response, html }) rendered escape-safe by the
 * contract card renderer.
 *
 * FAIL OPEN TO LOCAL: any remote failure returns { ok:false, fallback:
 * 'local' } and the chat canvas continues down its existing Executive
 * Copilot path — the remote layer can only ADD capability, never take chat
 * offline. Pure routing + packaging; no storage, no mutation.
 */
;(function (global) {
  'use strict';

  function remote() { return global.AAA_COPILOT_REMOTE; }
  function renderer() { return global.AAA_CONTRACT_CARD_RENDERER; }

  // Deterministic keyword routing for the five phase-one jobs. Draft beats
  // followups (a draft request usually contains "follow-up"); risk requires a
  // quote reference to be actionable.
  const QUOTE_ID = /(quote_[a-z0-9_]+)/i;
  function classify(text) {
    const s = String(text == null ? '' : text).toLowerCase();
    if (!s.trim()) return null;
    const quote = String(text).match(QUOTE_ID);
    const quoteId = quote ? quote[1] : null;
    if (/\bdraft\b/.test(s)) return quoteId ? { job: 'draft_followup', quoteId: quoteId } : null;
    if (/(underpriced|at risk|risky|price.*right|estimate risk)/.test(s) && quoteId) return { job: 'estimate_risk', quoteId: quoteId };
    if (/follow.?up/.test(s)) return { job: 'followups' };
    if (/(agents?|overnight).*(do|did|activity)|what did the agents/.test(s)) return { job: 'agent_activity' };
    if (/(attention|needs? me|top of the list|what.?s urgent|today.?s priorities)/.test(s)) return { job: 'attention_today' };
    return null;
  }

  const Bridge = {
    classify: classify,

    /** Should the canvas hand this message to the remote copilot? */
    canHandle(text) {
      const r = remote();
      return !!(classify(text) && r && r.configured && r.configured());
    },

    /**
     * Remote round-trip → chat card. { ok, job, card, summary, response } or
     * { ok:false, fallback:'local', error } — the canvas falls through.
     */
    async ask(text, opts) {
      const route = classify(text);
      if (!route) return { ok: false, error: 'NO_JOB', fallback: 'local' };
      const r = remote();
      if (!r || !r.ask) return { ok: false, error: 'NO_REMOTE', fallback: 'local' };
      const res = await r.ask({ job: route.job, message: text, quoteId: route.quoteId });
      if (!res.ok) return { ok: false, error: res.error, fallback: 'local', issues: res.issues };
      const rd = renderer();
      const card = {
        type: 'copilot_contract',
        job: route.job,
        response: res.response,
        html: rd && rd.render ? rd.render(res.response) : null
      };
      return { ok: true, job: route.job, card: card, summary: res.response.answer, response: res.response };
    }
  };

  global.AAA_COPILOT_CHAT_BRIDGE = Bridge;
})(typeof window !== 'undefined' ? window : this);
