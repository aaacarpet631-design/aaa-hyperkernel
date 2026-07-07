/*
 * AAA Quote Store — the quote lifecycle spine.
 *
 * Turns an estimator draft into a first-class business record and tracks it
 * through its life: draft → reviewed → sent → (follow_up_due) → won | lost,
 * plus expired / archived. Every COMMITTING transition routes through the
 * Runtime Gateway (human-only + audited); drafting is the one AI-allowed write
 * (a recommendation, never a commitment).
 *
 * Hard rules (enforced by code):
 *   - No autonomous price finalization: committing transitions are aiAllowed:false
 *     in the gateway; AI can only create a draft.
 *   - No customer send without human review: `sent` is reachable ONLY from
 *     `reviewed`, and SEND_QUOTE requires APPROVE_QUOTE.
 *   - No accounting post from here: this module never calls an accounting
 *     mutator. Won/lost records final price + job cost ON THE QUOTE only.
 *   - All status changes audited (the gateway writes audit_log for each).
 *   - Won/lost become training signals: a lean `outcomes` record is written and
 *     the Supervisor scores it — feeding Prediction Ledger + close-rate metrics.
 *   - Internal labor/cost/margin stay hidden from the customer view.
 *
 * The `quotes` collection holds margin/cost/job-cost, so it is owner-only
 * (financial) in firestore.rules. The customer-facing receipt is derived via
 * customerView() and carries no internal numbers.
 */
;(function (global) {
  'use strict';

  const QUOTES = 'quotes';
  const OUTCOMES = 'outcomes';

  // Lifecycle states.
  const S = {
    DRAFT: 'draft', REVIEWED: 'reviewed', SENT: 'sent', FOLLOW_UP: 'follow_up_due',
    WON: 'won', LOST: 'lost', EXPIRED: 'expired', ARCHIVED: 'archived'
  };
  // Allowed transitions (terminal states can still be archived).
  const TRANSITIONS = {
    draft:         ['reviewed', 'expired', 'archived'],
    reviewed:      ['sent', 'draft', 'expired', 'archived'],
    sent:          ['follow_up_due', 'won', 'lost', 'expired', 'archived'],
    follow_up_due: ['won', 'lost', 'sent', 'expired', 'archived'],
    won:           ['archived'],
    lost:          ['archived'],
    expired:       ['archived', 'draft'],
    archived:      []
  };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function supervisor() { return global.AAA_SUPERVISOR; }
  function events() { return global.AAA_EVENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const Store = {
    QUOTES: QUOTES, STATUSES: S, TRANSITIONS: TRANSITIONS,

    // ---- read ----------------------------------------------------------
    async list() { return (await data().list(QUOTES)).filter(mine).sort(byNewest); },
    async get(id) { const r = await data().get(QUOTES, id); return mine(r) ? r : null; },
    async byStatus(status) { return (await this.list()).filter((q) => q.status === status); },
    /** Quotes that need a nudge: explicitly follow_up_due, or sent past `days`. */
    async followUpQueue(days) {
      const cutoff = Date.now() - (num(days) || 3) * 86400000;
      return (await this.list()).filter((q) => q.status === S.FOLLOW_UP ||
        (q.status === S.SENT && Date.parse(q.sentAt || q.updatedAt || '') <= cutoff));
    },

    /**
     * Create a DRAFT quote (the one AI-allowed write — a recommendation, not a
     * commitment). Accepts an estimator estimate plus business context.
     * @param {Object} input { estimate, customer?, jobId?, leadId?, leadSource?, zip?, sessions?, photos? }
     */
    async createDraft(input) {
      const i = input || {};
      const est = i.estimate || {};
      const q = est.quote || {};
      const internalCost = round(num(q._laborTotal) + num(q._materialTotal));
      const customerTotal = round(num(q.total != null ? q.total : (est.receipt && est.receipt.total)));
      const margin = customerTotal > 0 ? round(customerTotal - internalCost) : 0;
      const marginPct = customerTotal > 0 ? Math.round((margin / customerTotal) * 100) : null;
      const cust = i.customer || {};
      const id = i.id || newId('quote');
      const at = nowISO();

      const rec = {
        quoteId: id, id: id, workspaceId: ws(), status: S.DRAFT,
        // customer + context
        customerId: cust.id || i.customerId || null,
        customerName: cust.name || i.customerName || null,
        customerContact: { phone: cust.phone || null, address: cust.address || i.address || null },
        leadId: sanitizeLeadId(i.leadId),           // ties the quote to Lead OS / ad attribution (internal-only)
        leadSource: i.leadSource || cust.source || null,
        zip: i.zip || extractZip(cust.address || i.address) || null,
        jobId: i.jobId || est.jobId || null,
        // service + measurement
        serviceType: Array.isArray(est.services) ? est.services.slice() : (i.serviceType || []),
        measurement: Array.isArray(i.sessions) ? i.sessions.map(measSummary) : (i.measurement || []),
        media: Array.isArray(i.photos) ? i.photos.slice() : [],
        // estimator recommendation (advisory)
        estimatorRecommendation: {
          reasoning: est.reasoning || null, services: est.services || [],
          inferredServices: !!est.inferredServices, decisionId: est.decisionId || null
        },
        // INTERNAL (owner-only collection): cost logic + margin
        internalCost: { labor: round(num(q._laborTotal)), material: round(num(q._materialTotal)), total: internalCost, ruleNotes: flattenRuleNotes(q) },
        marginEstimate: margin, marginPct: marginPct,
        // customer-facing receipt (no internal numbers)
        customerReceipt: est.receipt || null,
        customerTotal: customerTotal,
        // scores
        confidence: est.confidence != null ? est.confidence : null,
        risk: est.risk != null ? est.risk : null,
        severity: est.severity || null,
        // lifecycle metadata
        statusHistory: [{ status: S.DRAFT, at: at, by: i.actor || 'estimator', origin: i.origin === 'ai' ? 'ai' : 'human' }],
        review: { reviewedBy: null, reviewedAt: null, notes: null },
        sentAt: null, followUpDueAt: null,
        wonLostReason: null, finalPrice: null, jobCost: null, grossMargin: null, resolvedAt: null,
        linkedReceiptIds: [], invoiceId: null, paymentId: null,
        supervisorNotes: [],
        createdAt: at, updatedAt: at
      };
      await put(rec);
      try { if (data().logAgent) data().logAgent('quote', 'Draft quote ' + (rec.customerName || id) + ' $' + customerTotal, { quoteId: id, jobId: rec.jobId }); } catch (_) {}
      if (events()) events().emit('quote.drafted', { quoteId: id, total: customerTotal });
      return rec;
    },

    // ---- committing transitions (human-only, audited) ------------------
    async markReviewed(id, opts) { return this._transition(id, S.REVIEWED, 'MODIFY_QUOTE', opts, (rec, o) => { rec.review = { reviewedBy: o.actor || null, reviewedAt: nowISO(), notes: o.notes || null }; }); },
    async send(id, opts) {
      const q = await this.get(id); if (!q) return { ok: false, error: 'NOT_FOUND' };
      if (q.status !== S.REVIEWED) return { ok: false, error: 'NEEDS_REVIEW', message: 'A person must review the quote before it can be sent.' };
      return this._transition(id, S.SENT, 'SEND_QUOTE', opts, (rec) => { rec.sentAt = nowISO(); });
    },
    async setFollowUp(id, opts) { const o = opts || {}; return this._transition(id, S.FOLLOW_UP, 'MODIFY_QUOTE', o, (rec) => { rec.followUpDueAt = o.dueAt || nowISO(); }); },
    async expire(id, opts) { return this._transition(id, S.EXPIRED, 'MODIFY_QUOTE', opts); },
    async archive(id, opts) { return this._transition(id, S.ARCHIVED, 'MODIFY_QUOTE', opts); },

    /** Mark WON → records final price/job cost/margin + writes a training signal. */
    async markWon(id, opts) {
      const o = opts || {};
      if (!o.reason) return { ok: false, error: 'REASON_REQUIRED', message: 'Record why the job was won.' };
      const finalPrice = round(num(o.finalPrice));
      const jobCost = o.jobCost != null ? round(num(o.jobCost)) : null;
      return this._transition(id, S.WON, 'RESOLVE_QUOTE', o, async (rec) => {
        rec.wonLostReason = String(o.reason);
        rec.finalPrice = finalPrice > 0 ? finalPrice : rec.customerTotal;
        rec.jobCost = jobCost;
        rec.grossMargin = (jobCost != null) ? round(rec.finalPrice - jobCost) : null;
        rec.resolvedAt = nowISO();
        await this._recordOutcome(rec, 'won');
      });
    },
    /** Mark LOST → writes a training signal (reason captured for learning). */
    async markLost(id, opts) {
      const o = opts || {};
      if (!o.reason) return { ok: false, error: 'REASON_REQUIRED', message: 'Record why the job was lost.' };
      return this._transition(id, S.LOST, 'RESOLVE_QUOTE', o, async (rec) => {
        rec.wonLostReason = String(o.reason);
        rec.resolvedAt = nowISO();
        await this._recordOutcome(rec, 'lost');
      });
    },

    /** Supervisor / reviewer annotation (advisory; not a status change). */
    async addSupervisorNote(id, input) {
      const i = input || {};
      const q = await this.get(id); if (!q) return { ok: false, error: 'NOT_FOUND' };
      const note = { note: String(i.note || ''), qualityScore: i.qualityScore != null ? num(i.qualityScore) : null, riskScore: i.riskScore != null ? num(i.riskScore) : null, by: i.by || 'supervisor', at: nowISO() };
      const rec = Object.assign({}, q, { supervisorNotes: (q.supervisorNotes || []).concat([note]), updatedAt: nowISO() });
      await put(rec);
      return { ok: true, quote: rec };
    },

    /** Link a posted receipt / invoice / payment to the quote (cross-reference only — no posting). */
    async link(id, links) {
      const q = await this.get(id); if (!q) return { ok: false, error: 'NOT_FOUND' };
      const l = links || {};
      const rec = Object.assign({}, q, {
        linkedReceiptIds: l.receiptId ? (q.linkedReceiptIds || []).concat([l.receiptId]) : q.linkedReceiptIds,
        invoiceId: l.invoiceId || q.invoiceId, paymentId: l.paymentId || q.paymentId, updatedAt: nowISO()
      });
      await put(rec); return { ok: true, quote: rec };
    },

    // ---- views ---------------------------------------------------------
    /** Customer-facing receipt — NO labor/material/cost/margin/confidence/risk. */
    customerView(quote) {
      if (!quote) return null;
      const r = quote.customerReceipt || {};
      return {
        businessName: r.businessName || cfg().businessName || 'AAA Carpet',
        customerName: quote.customerName || r.customerName || null,
        date: r.date || quote.createdAt,
        items: Array.isArray(r.items) ? r.items.map((it) => ({ description: it.description, amount: it.amount })) : [],
        total: quote.customerTotal != null ? quote.customerTotal : r.total,
        estimateRange: r.estimateRange || null,
        note: r.note || 'Estimate — final price confirmed on site.'
      };
    },

    // ---- stats (owner) -------------------------------------------------
    async stats() {
      const all = await this.list();
      const by = (s) => all.filter((q) => q.status === s).length;
      const resolved = all.filter((q) => q.status === S.WON || q.status === S.LOST);
      const won = all.filter((q) => q.status === S.WON);
      const pipeline = all.filter((q) => [S.DRAFT, S.REVIEWED, S.SENT, S.FOLLOW_UP].indexOf(q.status) !== -1);
      return {
        total: all.length,
        counts: { draft: by(S.DRAFT), reviewed: by(S.REVIEWED), sent: by(S.SENT), follow_up_due: by(S.FOLLOW_UP), won: won.length, lost: by(S.LOST), expired: by(S.EXPIRED), archived: by(S.ARCHIVED) },
        pipelineValue: round(pipeline.reduce((s, q) => s + num(q.customerTotal), 0)),
        closeRatePct: resolved.length ? Math.round((won.length / resolved.length) * 100) : null,
        wonRevenue: round(won.reduce((s, q) => s + num(q.finalPrice), 0)),
        wonMargin: round(won.reduce((s, q) => s + num(q.grossMargin), 0))
      };
    },

    // ---- internals -----------------------------------------------------
    async _transition(id, toStatus, action, opts, applyFn) {
      const o = opts || {};
      const q = await this.get(id);
      if (!q) return { ok: false, error: 'NOT_FOUND' };
      const allowed = TRANSITIONS[q.status] || [];
      if (allowed.indexOf(toStatus) === -1) return { ok: false, error: 'INVALID_TRANSITION', message: 'Cannot move a ' + q.status + ' quote to ' + toStatus + '.' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: action, origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'quote', id: id }, detail: { from: q.status, to: toStatus },
        mutate: async () => {
          const rec = Object.assign({}, q, { status: toStatus, updatedAt: nowISO() });
          rec.statusHistory = (q.statusHistory || []).concat([{ status: toStatus, at: nowISO(), by: o.actor || null, origin: o.origin === 'ai' ? 'ai' : 'human', reason: o.reason || null }]);
          if (applyFn) await applyFn(rec, o);
          await put(rec);
          if (events()) events().emit('quote.' + toStatus, { quoteId: id, jobId: rec.jobId });
          return rec;
        }
      });
      if (!res.ok) return res;
      return { ok: true, quote: res.result, auditId: res.auditId };
    },

    /**
     * Write the won/lost TRAINING SIGNAL into the shared `outcomes` collection
     * (lean — no margin/cost leak) and let the Supervisor score it. This is what
     * Outcome Learning + the Prediction Ledger + close-rate metrics consume.
     */
    async _recordOutcome(quote, result) {
      const outcome = {
        id: newId('out'), jobId: quote.jobId || null, quoteId: quote.quoteId,
        leadId: quote.leadId || null,
        result: result,                                   // 'won' | 'lost'
        finalAmount: result === 'won' ? num(quote.finalPrice) : null,
        serviceType: quote.serviceType, zip: quote.zip, leadSource: quote.leadSource,
        reason: quote.wonLostReason, source: 'quote_lifecycle',
        workspaceId: ws(), recordedAt: nowISO()
      };
      try {
        await data().put(OUTCOMES, outcome.id, outcome);
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity(OUTCOMES, outcome.id, outcome);
      } catch (_) {}
      try { if (supervisor() && supervisor().scoreOutcome) await supervisor().scoreOutcome(outcome); } catch (_) {}
      if (events()) events().emit('outcome.recorded', { quoteId: quote.quoteId, result: result });
      return outcome;
    }
  };

  // ---- pure helpers -----------------------------------------------------
  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  function measSummary(s) { return s ? { roomName: s.roomName, squareFeet: s.squareFeet, linearFeet: s.linearFeet, stairsCount: s.stairsCount } : null; }
  function flattenRuleNotes(q) { return [].concat.apply([], ((q && q.lines) || []).map((l) => l._ruleNotes || [])); }
  function extractZip(addr) { if (!addr) return null; const m = String(addr).match(/\b(\d{5})(?:-\d{4})?\b/); return m ? m[1] : null; }
  function sanitizeLeadId(v) { if (v == null) return null; const s = String(v).trim().slice(0, 64); return s || null; }
  async function put(rec) {
    await data().put(QUOTES, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(QUOTES, rec.id, rec); } catch (_) {}
  }

  global.AAA_QUOTES = Store;
})(typeof window !== 'undefined' ? window : this);
