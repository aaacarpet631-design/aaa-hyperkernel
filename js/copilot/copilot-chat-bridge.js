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
 * contract card renderer. A draft_message card in the reply is additionally
 * FILED into the assisted-drafts queue (pending human approval, source
 * 'copilot', never sent) and the card carries draftQueuedId — advisory only,
 * a filing failure never breaks the chat reply.
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
  function drafts() { return global.AAA_ASSISTED_DRAFTS; }

  // Deterministic keyword routing for the five phase-one jobs, as an ORDERED
  // per-job pattern table. Row order is precedence: draft beats followups (a
  // draft request usually contains "follow-up"). Quote handling per row:
  //   'require'      — pattern matched but no quote reference → NOT claimed
  //                    (a draft without a quote isn't actionable);
  //   'skip_without' — pattern matched but no quote reference → keep looking
  //                    (risk talk without a quote may still be a follow-up
  //                    or attention question).
  // Rows without a quote rule never attach a quoteId. Anything the table
  // doesn't match returns null — ordinary chat is never claimed.
  const QUOTE_ID = /(quote_[a-z0-9_]+)/i;
  const ROUTES = [
    { job: 'draft_followup', quote: 'require', patterns: [/\bdraft\b/] },
    { job: 'estimate_risk', quote: 'skip_without', patterns: [/underpriced/, /at risk/, /risky/, /price.*right/, /estimate risk/] },
    { job: 'followups', patterns: [/follow.?up/] },
    { job: 'agent_activity', patterns: [/(agents?|overnight).*(do|did|activity)/, /what did the agents/, /what happened overnight/, /overnight (summary|recap|report)/] },
    { job: 'attention_today', patterns: [/attention/, /needs? me/, /top of the list/, /what.?s urgent/, /today.?s priorities/] }
  ];
  function classify(text) {
    const s = String(text == null ? '' : text).toLowerCase();
    if (!s.trim()) return null;
    const quote = String(text).match(QUOTE_ID);
    const quoteId = quote ? quote[1] : null;
    for (let i = 0; i < ROUTES.length; i++) {
      const row = ROUTES[i];
      if (!row.patterns.some(function (p) { return p.test(s); })) continue;
      if (row.quote === 'require') return quoteId ? { job: row.job, quoteId: quoteId } : null;
      if (row.quote === 'skip_without' && !quoteId) continue;
      return row.quote ? { job: row.job, quoteId: quoteId } : { job: row.job };
    }
    return null;
  }

  // Advisory side-effect: a remote draft_message card is FILED into the
  // assisted-drafts queue (pending human approval, source 'copilot', never
  // sent). Returns the queued draft id or null — any failure here is
  // swallowed by the caller; filing can never break the chat reply.
  //
  // Filed-once discipline: the adapter's single-flight dedupe hands the SAME
  // response to every concurrent identical ask, so filing must key on the
  // response's requestId — otherwise a double-click files duplicate drafts.
  // Bounded memory: the map only ever holds the last few requestIds.
  const FILED = {};
  const FILED_ORDER = [];
  function alreadyFiled(requestId) {
    if (!requestId) return false;
    if (FILED[requestId]) return true;
    FILED[requestId] = true;
    FILED_ORDER.push(requestId);
    while (FILED_ORDER.length > 50) delete FILED[FILED_ORDER.shift()];
    return false;
  }
  async function fileDraftCard(dm) {
    const q = drafts();
    if (!q || typeof q.file !== 'function' || !dm) return null;
    // The engine falls back to the QUOTE ref when the packet carried no
    // customer item — a quote id must never persist as a customerId.
    const customerId = dm.customerRef && dm.customerRef.collection === 'customers' ? dm.customerRef.id : null;
    const filed = await q.file({
      channel: dm.channel,
      body: dm.body,
      customerId: customerId,
      intent: 'follow_up',
      source: 'copilot',
      origin: 'ai'
    });
    return filed && filed.ok && filed.draft ? filed.draft.id : null;
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
      // A drafted follow-up also lands in the assisted-drafts queue so the
      // owner can approve/edit it later from the Approval Inbox. Advisory:
      // a filing failure never breaks the chat reply.
      const dm = (Array.isArray(res.response.cards) ? res.response.cards : []).filter(function (c) { return c && c.cardType === 'draft_message'; })[0];
      if (dm && !alreadyFiled(res.response.requestId)) {
        try {
          const queuedId = await fileDraftCard(dm);
          if (queuedId) card.draftQueuedId = queuedId;
        } catch (_) { /* advisory — the chat reply stands on its own */ }
      }
      return { ok: true, job: route.job, card: card, summary: res.response.answer, response: res.response };
    }
  };

  global.AAA_COPILOT_CHAT_BRIDGE = Bridge;
})(typeof window !== 'undefined' ? window : this);
