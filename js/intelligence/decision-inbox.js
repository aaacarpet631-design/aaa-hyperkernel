/*
 * AAA Decision Inbox — the governed "Decision Card" engine (DRY-RUN pilot).
 *
 * Turns the Opportunity Scorer's per-quote intelligence into a single,
 * schema-locked DECISION CARD the owner can approve with one tap: a proposed
 * SMS follow-up with expected value, confidence, an honest rationale (straight
 * from the scorer's basis — never invented here), and a recipient. Approval is
 * GOVERNED: re-validate → safety gate → typed event → audit ledger.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ HARD SAFETY CONSTRAINT — THIS MODULE IS DRY-RUN ONLY.                    ║
 * ║ dispatch() must NEVER send a real SMS/email and must never call any      ║
 * ║ transport/messaging API (no AAA_TRANSPORT*, no AAA_SMS*, no fetch).      ║
 * ║ "Dispatch" here means: safety-gate the action, publish a governed        ║
 * ║ 'decision.approved' event, append an audit entry, and return a dry-run   ║
 * ║ result with dispatched:false. Even an explicit { live:true } opt is      ║
 * ║ DELIBERATELY IGNORED (see the guard in dispatch). Real dispatch is a     ║
 * ║ separate, compliance-gated ticket; enabling it requires REMOVING the     ║
 * ║ guard below on purpose — it cannot be flipped on by a flag.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Schema v1.0 (authoritative — validateDecisionSchema enforces it strictly):
 *   { decisionId, schemaVersion:'1.0',
 *     trigger:{ event, timestamp, payload:{ quoteId, customerId, customerName } },
 *     agent:'SalesDirectorAI',
 *     proposal:{ actionType:'SEND_COMMUNICATION', channel:'SMS', templateId,
 *       metrics:{ expectedValueUSD>=0, confidenceScore 0..1, rationale },
 *       payload:{ recipient, body } },
 *     governance:{ status:'AWAITING_APPROVAL', policy:'MANUAL_REVIEW_REQUIRED' } }
 *
 * Privacy: the audit record is PII-minimal — customer NAME + quoteId only,
 * never the phone number (that stays on the card, which is not persisted).
 * Everything is null-safe: missing stores/bus/gate/ledger degrade to an honest
 * { ok:false, reason } or a noted skip — never a throw.
 */
;(function (global) {
  'use strict';

  const SCHEMA_VERSION = '1.0';
  const AGENT = 'SalesDirectorAI';
  const TEMPLATE_ID = 'followup_sms_v1';
  const OPEN_STATUSES = ['draft', 'reviewed', 'sent', 'follow_up_due'];
  const ELIGIBLE_URGENCY = { now: true, today: true };

  function quotes() { return global.AAA_QUOTES; }
  function customers() { return global.AAA_CUSTOMER_STORE; }
  function scorer() { return global.AAA_OPPORTUNITY_SCORER; }
  function gate() { return global.AAA_ACTION_GATE; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function nonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }

  /** Honest one-liner straight from the scorer's basis — never invented. */
  function rationaleFor(score) {
    const method = (score.basis && score.basis.method) || 'unknown';
    if (method === 'segment_blend') return 'Similar quotes in this segment closed at ' + score.probabilityPct + '%';
    if (method === 'overall_rate') return 'Company win rate ' + score.probabilityPct + '%';
    return 'No outcome history yet — sending to learn';
  }

  /** Short templated follow-up. Name only — no other PII in the body. */
  function bodyFor(customerName) {
    const name = customerName ? String(customerName) : 'there';
    return 'Hi ' + name + ' — just checking in on your AAA Carpet estimate. ' +
      'Happy to answer any questions or get you on the schedule. Reply YES and we’ll set it up.';
  }

  /** Phone from the quote's contact, else the customer record. Null if none. */
  async function recipientFor(quote) {
    const direct = quote && quote.customerContact && quote.customerContact.phone;
    if (direct) return String(direct);
    const cs = customers();
    if (quote && quote.customerId && cs && typeof cs.get === 'function') {
      try {
        const c = await cs.get(quote.customerId);
        if (c && c.phone) return String(c.phone);
      } catch (_) { /* fall through */ }
    }
    return null;
  }

  const Inbox = {
    /* dryRun is informational only — dispatch() does NOT consult it. There is
     * no live path in this module at all, so flipping this flag changes
     * nothing; see the HARD GUARD in dispatch(). */
    FLAGS: { cardsEnabled: true, dryRun: true },
    SCHEMA_VERSION: SCHEMA_VERSION,
    AGENT: AGENT,

    /**
     * Build a follow-up Decision Card from a real quote + the real scorer.
     * @param {Object} [opts] { quoteId } — without it, picks the highest-
     *   expected-value OPEN quote whose recommended urgency is 'now'/'today'.
     * @returns {{ok:true, card:Object}} | {{ok:false, reason:string}}
     *   reasons: NO_ELIGIBLE_QUOTE | NO_RECIPIENT | NO_SCORER | SCORE_FAILED
     */
    async buildFollowUpDecision(opts) {
      try {
        const o = opts || {};
        const sc = scorer();
        if (!sc || typeof sc.score !== 'function') return { ok: false, reason: 'NO_SCORER' };
        const qs = quotes();
        if (!qs || typeof qs.get !== 'function') return { ok: false, reason: 'NO_ELIGIBLE_QUOTE' };

        let quote = null, score = null;
        if (o.quoteId) {
          quote = await qs.get(o.quoteId);
          if (!quote || OPEN_STATUSES.indexOf(quote.status) === -1) return { ok: false, reason: 'NO_ELIGIBLE_QUOTE' };
          score = await sc.score(quote);
        } else {
          if (typeof sc.scoreAll !== 'function') return { ok: false, reason: 'NO_SCORER' };
          const all = await sc.scoreAll();
          if (!all || !all.ok || !Array.isArray(all.items)) return { ok: false, reason: 'NO_ELIGIBLE_QUOTE' };
          // items are already ranked by expectedValue desc — take the first URGENT one.
          score = all.items.filter(function (d) { return d && ELIGIBLE_URGENCY[d.urgency]; })[0] || null;
          if (!score) return { ok: false, reason: 'NO_ELIGIBLE_QUOTE' };
          quote = await qs.get(score.quoteId);
          if (!quote) return { ok: false, reason: 'NO_ELIGIBLE_QUOTE' };
        }
        if (!score || !score.ok) return { ok: false, reason: 'SCORE_FAILED' };

        const recipient = await recipientFor(quote);
        if (!recipient) return { ok: false, reason: 'NO_RECIPIENT' };

        const customerName = quote.customerName || null;
        const card = {
          decisionId: newId('dec'),
          schemaVersion: SCHEMA_VERSION,
          trigger: {
            event: quote.status === 'follow_up_due' ? 'quote.follow_up_due' : 'quote.open_idle',
            timestamp: nowISO(),
            payload: { quoteId: quote.quoteId || quote.id || null, customerId: quote.customerId || null, customerName: customerName }
          },
          agent: AGENT,
          proposal: {
            actionType: 'SEND_COMMUNICATION',
            channel: 'SMS',
            templateId: TEMPLATE_ID,
            metrics: {
              expectedValueUSD: score.expectedValue,   // probability × customerTotal, from the scorer
              confidenceScore: score.probability,      // 0..1, from the scorer
              rationale: rationaleFor(score)           // honest, from score.basis
            },
            payload: { recipient: recipient, body: bodyFor(customerName) }
          },
          governance: { status: 'AWAITING_APPROVAL', policy: 'MANUAL_REVIEW_REQUIRED' }
        };
        return { ok: true, card: card };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    },

    /**
     * Strict schema check. @returns { valid:boolean, reason?:string }
     */
    validateDecisionSchema(card) {
      function bad(reason) { return { valid: false, reason: reason }; }
      if (!card || typeof card !== 'object') return bad('NOT_AN_OBJECT');
      if (!nonEmptyStr(card.decisionId)) return bad('MISSING_DECISION_ID');
      if (card.schemaVersion !== SCHEMA_VERSION) return bad('BAD_SCHEMA_VERSION');
      const tr = card.trigger;
      if (!tr || typeof tr !== 'object') return bad('MISSING_TRIGGER');
      if (!nonEmptyStr(tr.event)) return bad('MISSING_TRIGGER_EVENT');
      if (!nonEmptyStr(tr.timestamp)) return bad('MISSING_TRIGGER_TIMESTAMP');
      if (!tr.payload || typeof tr.payload !== 'object') return bad('MISSING_TRIGGER_PAYLOAD');
      if (!nonEmptyStr(card.agent)) return bad('MISSING_AGENT');
      const p = card.proposal;
      if (!p || typeof p !== 'object') return bad('MISSING_PROPOSAL');
      if (p.actionType !== 'SEND_COMMUNICATION') return bad('BAD_ACTION_TYPE');
      if (p.channel !== 'SMS') return bad('BAD_CHANNEL');
      if (!nonEmptyStr(p.templateId)) return bad('MISSING_TEMPLATE_ID');
      const m = p.metrics;
      if (!m || typeof m !== 'object') return bad('MISSING_METRICS');
      if (!isNum(m.expectedValueUSD) || m.expectedValueUSD < 0) return bad('BAD_EXPECTED_VALUE');
      if (!isNum(m.confidenceScore) || m.confidenceScore < 0 || m.confidenceScore > 1) return bad('BAD_CONFIDENCE');
      if (!nonEmptyStr(m.rationale)) return bad('MISSING_RATIONALE');
      const pl = p.payload;
      if (!pl || typeof pl !== 'object') return bad('MISSING_PAYLOAD');
      if (!nonEmptyStr(pl.recipient)) return bad('MISSING_RECIPIENT');
      if (!nonEmptyStr(pl.body)) return bad('MISSING_BODY');
      const g = card.governance;
      if (!g || typeof g !== 'object') return bad('MISSING_GOVERNANCE');
      if (g.status !== 'AWAITING_APPROVAL') return bad('BAD_GOVERNANCE_STATUS');
      if (g.policy !== 'MANUAL_REVIEW_REQUIRED') return bad('BAD_GOVERNANCE_POLICY');
      return { valid: true };
    },

    /**
     * DRY-RUN governed approval of a Decision Card.
     * Steps: re-validate → safety gate → publish 'decision.approved' → audit.
     * @returns {{ok:true, dryRun:true, dispatched:false, decisionId, gate, skipped:string[]}}
     *        | {{ok:false, reason}} | {{ok:false, blocked:true, reason, gate}}
     */
    async dispatch(card, opts) {
      try {
        const o = opts || {};
        // ════════════════════ HARD GUARD — DO NOT REMOVE ════════════════════
        // This pilot NEVER sends. opts.live is DELIBERATELY IGNORED: real
        // dispatch is a separate, compliance-gated ticket (consent, opt-out,
        // carrier registration). A future dev cannot flip this on with a flag;
        // they must remove this guard knowingly and ship the real transport
        // path behind its own review. Until then dispatched is always false.
        if (o.live) { /* ignored on purpose — see comment above */ }
        // ═════════════════════════════════════════════════════════════════════

        // (1) re-validate — a stale/mutated card never reaches the gate.
        const v = this.validateDecisionSchema(card);
        if (!v.valid) return { ok: false, reason: v.reason || 'INVALID_CARD' };

        const quoteId = card.trigger.payload.quoteId || null;
        const skipped = [];

        // (2) normalized action through the safety gate. The gate classifies
        // an outbound SMS as needs_approval (external) — that requirement is
        // satisfied HERE, because dispatch() is only reachable from a human's
        // explicit "Approve Send" tap. Only an outright 'deny' blocks.
        let verdict = null;
        const g = gate();
        if (g && typeof g.assess === 'function') {
          try {
            verdict = g.assess({
              type: 'SEND_COMMUNICATION', channel: card.proposal.channel,
              recipient: card.proposal.payload.recipient, body: card.proposal.payload.body,
              quoteId: quoteId,
              description: 'send sms follow-up message to customer for quote ' + (quoteId || '(unknown)')
            });
          } catch (_) { verdict = null; }
          if (verdict && verdict.decision === 'deny') {
            return { ok: false, blocked: true, reason: (verdict.reasons || []).join('; ') || 'denied by safety gate', gate: verdict };
          }
        } else {
          skipped.push('gate');
        }

        // (3) governed typed event — define the contract lazily (idempotent).
        const b = bus();
        if (b && typeof b.publish === 'function') {
          try {
            if (typeof b.define === 'function' && !(typeof b.contract === 'function' && b.contract('decision.approved'))) {
              b.define('decision.approved', {
                version: 1,
                description: 'A human approved an AI decision card (Decision Inbox pilot — dry-run only).',
                schema: {
                  type: 'object', required: ['decisionId'],
                  properties: { decisionId: { type: 'string' }, quoteId: { type: 'string' }, expectedValueUSD: { type: 'number' }, dryRun: { type: 'boolean' } }
                }
              });
            }
            const payload = { decisionId: card.decisionId, expectedValueUSD: card.proposal.metrics.expectedValueUSD, dryRun: true };
            if (quoteId) payload.quoteId = quoteId;
            const pub = await b.publish('decision.approved', payload, { source: 'decision_inbox' });
            if (!pub || !pub.ok) skipped.push('event');
          } catch (_) { skipped.push('event'); }
        } else {
          skipped.push('event');
        }

        // (4) audit entry — PII-minimal: name + quoteId, NEVER the phone number.
        const l = ledger();
        if (l && typeof l.append === 'function') {
          try {
            await l.append('decision_approved', {
              kind: 'decision_approved',
              decisionId: card.decisionId,
              quoteId: quoteId,
              customerName: card.trigger.payload.customerName || null,
              agent: card.agent,
              templateId: card.proposal.templateId,
              expectedValueUSD: card.proposal.metrics.expectedValueUSD,
              confidenceScore: card.proposal.metrics.confidenceScore,
              gate: verdict ? verdict.decision : 'skipped',
              dryRun: true, dispatched: false
            });
          } catch (_) { skipped.push('audit'); }
        } else {
          skipped.push('audit');
        }

        // (5) dry-run result. dispatched is hard-coded false — no send happened.
        return { ok: true, dryRun: true, dispatched: false, decisionId: card.decisionId, gate: verdict ? verdict.decision : null, skipped: skipped };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    }
  };

  global.AAA_DECISION_INBOX = Inbox;
})(typeof window !== 'undefined' ? window : this);
