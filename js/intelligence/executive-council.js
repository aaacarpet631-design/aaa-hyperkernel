/*
 * AAA Executive Council — a visible C-suite review for HIGH-IMPACT decisions.
 *
 * Distinct from the quote-level Supervisor Council (AAA_AGENT_COUNCIL): this one
 * reviews the big, hard-to-reverse calls — a price change, marketing / Google
 * Ads spend, a hire, or a large quote — through five executive lenses:
 *   CEO · Risk · Finance · Sales · Operations
 * Each seat takes a STANCE (support / caution / oppose) with a confidence and an
 * optional objection; the CEO synthesizes one advisory recommendation with a
 * risk score and the surfaced objections. The owner then approves or overrides.
 *
 * Governance: the council ONLY recommends. A review is `pending_approval` until a
 * person acts through the gateway (REVIEW_EXECUTIVE, human-only + audited). It
 * changes no price, budget, or record on its own — no autonomous execution.
 * Deterministic + null-tolerant; pulls light context from Outcome Intelligence /
 * Outcome Learning when present, else from the proposal itself.
 */
;(function (global) {
  'use strict';

  const REVIEWS = 'executive_reviews';
  const TYPES = ['price_change', 'marketing_spend', 'ads_budget', 'hiring', 'large_quote', 'new_territory', 'add_truck'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  const pos = (seat, stance, confidence, objection, rationale) => ({ seat: seat, stance: stance, confidence: clamp(Math.round(confidence), 0, 100), objection: objection || null, rationale: rationale || '' });

  // ---- the five executive lenses (pure) ------------------------------------
  const SEATS = {
    finance: function (p, c) {
      const amt = num(p.amount);
      if (p.type === 'price_change') {
        const down = (p.detail && p.detail.direction) === 'down';
        const margin = num(c.marginPct), floor = num(c.marginFloor) || 25;
        if (down && margin != null && margin <= floor) return pos('Finance', 'oppose', 80, 'A price cut takes margin (' + margin + '%) to/under the ' + floor + '% floor.', 'Protect the floor.');
        return pos('Finance', down ? 'caution' : 'support', 65, down ? 'Watch blended margin after the cut.' : null, down ? 'Cuts need volume to pay back.' : 'Raising price protects margin.');
      }
      if (p.type === 'marketing_spend' || p.type === 'ads_budget') {
        const roi = num(c.marketingRoi);
        if (amt != null && c.cashBuffer != null && amt > num(c.cashBuffer)) return pos('Finance', 'oppose', 75, 'Spend ($' + amt + ') exceeds the cash buffer ($' + c.cashBuffer + ').', 'Stay within cash.');
        if (roi != null && roi < 1) return pos('Finance', 'caution', 60, 'Channel ROI is below 1.0 — spend may not return.', null);
        return pos('Finance', 'support', 55, null, 'Affordable; ROI acceptable.');
      }
      if (p.type === 'hiring' || p.type === 'add_truck' || p.type === 'new_territory') {
        if (c.cashBuffer != null && amt != null && amt > num(c.cashBuffer) * 0.5) return pos('Finance', 'oppose', 70, 'Fixed-cost commitment is large vs the cash buffer.', 'Confirm runway first.');
        return pos('Finance', 'caution', 55, 'A recurring cost — confirm sustained demand.', null);
      }
      if (p.type === 'large_quote') { const m = num((p.detail && p.detail.marginPct)); const floor = num(c.marginFloor) || 25; if (m != null && m < floor) return pos('Finance', 'oppose', 75, 'Quote margin ' + m + '% is under the ' + floor + '% floor.', 'Re-price.'); return pos('Finance', 'support', 60, null, 'Margin acceptable.'); }
      return pos('Finance', 'caution', 40, null, 'No financial signal.');
    },
    risk: function (p, c) {
      const irreversible = ['hiring', 'add_truck', 'new_territory'].indexOf(p.type) !== -1;
      const dataThin = (c.sample != null && num(c.sample) < 5);
      if (irreversible && dataThin) return pos('Risk', 'oppose', 70, 'A hard-to-reverse commitment on thin data (' + (c.sample || 0) + ' samples).', 'Gather evidence first.');
      if (irreversible) return pos('Risk', 'caution', 60, 'Hard to reverse — stage it and set a kill-criterion.', null);
      if (p.type === 'price_change' && (p.detail && p.detail.direction) === 'down') return pos('Risk', 'caution', 55, 'Price cuts are hard to walk back with customers.', null);
      if ((p.type === 'marketing_spend' || p.type === 'ads_budget') && dataThin) return pos('Risk', 'caution', 50, 'Limited ROI history to justify the spend.', null);
      return pos('Risk', 'support', 45, null, 'Reversible / bounded downside.');
    },
    sales: function (p, c) {
      const win = num(c.winRate);
      if (p.type === 'marketing_spend' || p.type === 'ads_budget' || p.type === 'new_territory') return pos('Sales', 'support', 65, null, 'More qualified demand grows the pipeline.');
      if (p.type === 'price_change') { const up = (p.detail && p.detail.direction) !== 'down'; if (up && win != null && win < 0.4) return pos('Sales', 'oppose', 65, 'Win rate is already soft (' + Math.round(win * 100) + '%); a raise risks more losses.', 'Hold or segment the raise.'); return pos('Sales', up ? 'caution' : 'support', 55, null, up ? 'Raises can cost deals — test it.' : 'A cut can lift close rate.'); }
      if (p.type === 'large_quote') return pos('Sales', 'support', 60, null, 'A marquee win — worth pursuing.');
      return pos('Sales', 'caution', 40, null, 'Neutral on growth.');
    },
    operations: function (p, c) {
      const util = num(c.capacityUtil);
      if (p.type === 'hiring' || p.type === 'add_truck' || p.type === 'new_territory') { if (util != null && util < 70) return pos('Operations', 'oppose', 65, 'Crew utilization is only ' + util + '% — capacity exists already.', 'Fill current capacity first.'); return pos('Operations', 'support', 60, null, 'Capacity is tight; expansion is justified.'); }
      if (p.type === 'large_quote') return pos('Operations', 'caution', 55, 'Confirm the schedule + crew can deliver on time.', null);
      if (p.type === 'marketing_spend' || p.type === 'ads_budget') { if (util != null && util > 90) return pos('Operations', 'caution', 55, 'Near capacity — more leads may outrun delivery.', null); return pos('Operations', 'support', 50, null, 'Capacity can absorb the demand.'); }
      return pos('Operations', 'caution', 40, null, 'No operational signal.');
    }
  };

  function deliberate(proposal, ctx) {
    const p = proposal || {}; const c = ctx || {};
    const positions = ['finance', 'risk', 'sales', 'operations'].map((k) => { try { return SEATS[k](p, c); } catch (_) { return pos(k, 'caution', 30, null, ''); } });
    const w = { support: 0, caution: 0, oppose: 0 };
    positions.forEach((x) => { w[x.stance] += x.confidence / 100; });
    const objections = positions.filter((x) => x.objection).map((x) => ({ seat: x.seat, objection: x.objection }));
    const hardOppose = positions.filter((x) => x.stance === 'oppose');
    // CEO synthesis.
    let decision = 'approve';
    if (hardOppose.some((x) => x.seat === 'Finance' || x.seat === 'Risk')) decision = 'reject';
    else if (w.oppose >= w.support || objections.length >= 2) decision = 'revise';
    else if (w.oppose > 0) decision = 'revise';
    const total = w.support + w.caution + w.oppose || 1;
    const confidence = Math.round((decision === 'approve' ? w.support : decision === 'reject' ? w.oppose : (w.caution + w.oppose) / 2) / total * 100);
    const riskScore = clamp(Math.round(25 + hardOppose.length * 20 + objections.length * 8 + (['hiring', 'add_truck', 'new_territory'].indexOf(p.type) !== -1 ? 15 : 0) - (decision === 'approve' ? 10 : 0)), 0, 100);
    const ceo = pos('CEO', decision === 'approve' ? 'support' : decision === 'reject' ? 'oppose' : 'caution', confidence, null,
      decision === 'approve' ? 'Proceed — the case holds across lenses.' : decision === 'reject' ? 'Do not proceed — a core objection stands.' : 'Revise — address the objections, then resubmit.');
    return { decision: decision, confidence: confidence, riskScore: riskScore, positions: [ceo].concat(positions), objections: objections, tally: { support: round1(w.support), caution: round1(w.caution), oppose: round1(w.oppose) }, needsOwnerApproval: true };
  }

  const Council = {
    REVIEWS: REVIEWS, TYPES: TYPES, SEATS: Object.keys(SEATS).map((k) => k),
    /** Pure executive deliberation over a proposal + context. */
    deliberate: deliberate,

    /** Build context, deliberate, and file a pending review. Recommendation-only. */
    async submit(proposal, opts) {
      const o = opts || {};
      const p = proposal || {};
      if (TYPES.indexOf(p.type) === -1) return { ok: false, error: 'UNKNOWN_TYPE' };
      const ctx = await this._context(p, o.context);
      const result = deliberate(p, ctx);
      const id = newId('exr');
      const rec = Object.assign({ id: id, workspaceId: ws(), type: p.type, title: p.title || p.type, amount: p.amount != null ? p.amount : null, detail: p.detail || null, context: ctx, status: 'pending_approval', ownerDecision: null, approvedBy: null, approvedAt: null, createdAt: nowISO() }, result);
      await put(rec);
      return { ok: true, review: rec };
    },
    async list(status) { const all = (await data().list(REVIEWS)).filter(mine); return (status ? all.filter((r) => r.status === status) : all).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async get(id) { const r = await data().get(REVIEWS, id); return mine(r) ? r : null; },

    /** Owner accepts or overrides the council — gateway-audited. Advisory. */
    async act(reviewId, opts) {
      const o = opts || {};
      const r = await this.get(reviewId); if (!r) return { ok: false, error: 'NOT_FOUND' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const ownerDecision = ['approve', 'revise', 'reject'].indexOf(o.decision) !== -1 ? o.decision : r.decision;
      const res = await gw.run({ action: 'REVIEW_EXECUTIVE', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'executive_review', id: reviewId }, detail: { councilDecision: r.decision, ownerDecision: ownerDecision } });
      if (!res.ok) return res;
      const rec = Object.assign({}, r, { status: 'reviewed', ownerDecision: ownerDecision, overridden: ownerDecision !== r.decision, approvedBy: o.actor || null, approvedAt: nowISO() });
      await put(rec);
      return { ok: true, review: rec, auditId: res.auditId };
    },

    /** Advisory narrative for a review via the governed Instruct model (if live).
     *  Pure advisory — it never changes the decision or the review. */
    async narrate(reviewId, opts) {
      const o = opts || {};
      const r = await this.get(reviewId); if (!r) return { ok: false, error: 'NOT_FOUND' };
      const router = global.AAA_GOVERNED_MODEL_ROUTER; if (!router) return { ok: false, error: 'NO_MODEL_ROUTER' };
      const res = await router.call({ taskType: 'executive_council_reasoning', input: { title: r.title, decision: r.decision, objections: r.objections, riskScore: r.riskScore }, context: { subject: 'executive_review', id: reviewId }, actor: o.actor || null, origin: o.origin, agent: 'executive_council', ownerApprovalRequired: true });
      return { ok: true, advisory: true, narrative: res.output ? (res.output.text || null) : null, envelope: res };
    },

    async _context(p, override) {
      const c = Object.assign({}, override || {});
      if (c.winRate == null || c.marginPct == null || c.sample == null) {
        try { if (learning() && learning().aggregate) { const agg = await learning().aggregate(); if (agg && agg.overall) { if (c.winRate == null) c.winRate = agg.overall.winRate; if (c.marginPct == null) c.marginPct = agg.overall.avgMarginPct; if (c.sample == null) c.sample = agg.overall.resolved; } } } catch (_) {}
      }
      if (c.marginFloor == null) c.marginFloor = num(cfg().flag ? cfg().flag('councilMarginFloor', 25) : 25) || 25;
      return c;
    }
  };

  function round1(n) { return Math.round(n * 10) / 10; }
  async function put(rec) { await data().put(REVIEWS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(REVIEWS, rec.id, rec); } catch (_) {} }

  global.AAA_EXECUTIVE_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
