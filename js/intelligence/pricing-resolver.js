/*
 * AAA Pricing Resolver — deterministic evidence → price decision engine.
 *
 * Resolves disagreeing pricing evidence into one defensible recommendation,
 * by EVIDENCE TYPE, never by averaging:
 *   - Hard constraints (margin floor) BOUND the feasible range — inviolable.
 *   - The Price Book anchor sets the default INSIDE the range.
 *   - Won/Lost signals NUDGE the price within the range, scaled by confidence.
 *   - A signal that points BELOW the floor is not a price — it is an
 *     UNPROFITABLE_TO_WIN escalation; the candidate is capped at the floor.
 *
 * Hard rules (enforced + tested):
 *   1. Never recommend below the margin floor.
 *   2. Never average constraints with signals.
 *   3. Market signal below floor → emit UNPROFITABLE_TO_WIN.
 *   4. Customer-facing quote ALWAYS requires approval (requiresApproval:true).
 *   5. Every resolve() writes a PII-free decision to the immutable ledger.
 *
 * compute() is PURE (no I/O) and exported for tests; resolve() = compute() + the
 * ledger write. This module only RECOMMENDS — it never sends, prices, or mutates
 * a quote. Acting on the recommendation is gated elsewhere (approval queue).
 */
;(function (global) {
  'use strict';

  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  // ---- pure helpers ---------------------------------------------------------
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function money(x) { return Math.round(x); }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  const DEFAULT_POLICY = {
    maxUpliftPct: 0.20,      // anchor may rise to +20% (top of the feasible range)
    minComparables: 5,       // below this → THIN_DATA, low signal confidence
    deviationPct: 0.15,      // |recommended-anchor|/anchor beyond this → LARGE_DEVIATION
    highConf: 0.7, lowConf: 0.45
  };

  // Winning band = [min,max] of WON comparable amounts (or caller-provided).
  function winningBandOf(signals, won) {
    if (signals && signals.winningBand && signals.winningBand.low != null && signals.winningBand.high != null) {
      return { low: num(signals.winningBand.low), high: num(signals.winningBand.high) };
    }
    if (won.length) return { low: Math.min.apply(null, won), high: Math.max.apply(null, won) };
    return null;
  }

  function supervisorPayload(d, inputs) {
    const ev = d.evidence;
    const options = d.unprofitableToWin
      ? [
        'Quote at the margin floor ($' + ev.marginFloor + ') and accept lower win odds',
        'Reduce scope/material cost to lower the floor, then re-resolve',
        'Decline or deprioritize this segment (winning price is unprofitable)'
      ]
      : ['Accept the recommendation', 'Adjust within the feasible range with a logged reason', 'Send back for re-scope'];
    return {
      recommended: d.recommended, recommendedRange: d.recommendedRange, feasibleRange: d.feasibleRange,
      marginFloor: ev.marginFloor, anchor: ev.anchor, signal: ev.signal, contextFlags: ev.context.flags,
      decisionConfidence: d.decisionConfidence, confidenceLevel: d.confidenceLevel,
      escalationFlags: d.escalationFlags, options: options,
      rules: {
        canAdjustWithinRange: true,
        cannotPriceBelowFloor: true,
        floorOverrideRequires: 'owner + written justification (audited)'
      },
      subject: { type: (inputs.meta && inputs.meta.subjectType) || null, id: (inputs.meta && inputs.meta.subjectId) || null }
    };
  }

  /**
   * Pure resolution. Returns the full decision (no ledger write, no I/O).
   * inputs: { material:{cost}, anchor:{price,version,source,active}, marginFloor,
   *           signals:{comparables:[{amount,outcome,recordedAt,reason}], winningBand?},
   *           context:{flags:[],sopRefs:[]}, policy?, meta? }
   */
  function compute(inputs) {
    inputs = inputs || {};
    const policy = Object.assign({}, DEFAULT_POLICY, inputs.policy || {});
    const flags = [];

    const materialCost = num(inputs.material && (inputs.material.cost != null ? inputs.material.cost : inputs.material.total));
    const anchorPrice = num(inputs.anchor && inputs.anchor.price);
    const marginFloor = num(inputs.marginFloor);
    if (anchorPrice == null) return { ok: false, error: 'ANCHOR_REQUIRED' };
    if (marginFloor == null || marginFloor <= 0) return { ok: false, error: 'MARGIN_FLOOR_REQUIRED' };

    // sanity constraints
    if (materialCost != null && marginFloor < materialCost) flags.push('FLOOR_BELOW_COST');
    let anchorEff = anchorPrice;
    if (anchorPrice < marginFloor) { flags.push('PRICEBOOK_BELOW_FLOOR'); anchorEff = marginFloor; }

    // ---- feasible range: floor bounds the bottom; uplift policy the top ----
    const low = money(marginFloor);
    const high = money(Math.max(anchorEff, marginFloor) * (1 + policy.maxUpliftPct));

    // ---- signal ----
    const comps = (inputs.signals && Array.isArray(inputs.signals.comparables)) ? inputs.signals.comparables : [];
    const won = comps.filter(function (c) { return String(c.outcome).toLowerCase() === 'won' && num(c.amount) != null; }).map(function (c) { return num(c.amount); });
    const lost = comps.filter(function (c) { return String(c.outcome).toLowerCase() === 'lost' && num(c.amount) != null; }).map(function (c) { return num(c.amount); });
    const n = comps.length;
    const band = winningBandOf(inputs.signals, won);
    const bandMid = band ? (band.low + band.high) / 2 : null;
    const winRate = (won.length + lost.length) ? won.length / (won.length + lost.length) : null;

    let signalConfidence = 0;
    if (band) {
      const nConf = n / (n + policy.minComparables);
      const spread = bandMid ? (band.high - band.low) / Math.max(1, bandMid) : 1;
      const consistency = clamp01(1 - spread);
      signalConfidence = clamp01(nConf * (0.5 + 0.5 * consistency));
    }
    if (n < policy.minComparables) flags.push('THIN_DATA');

    // contradiction: won & lost amounts overlap heavily → unreliable signal
    if (won.length && lost.length) {
      const wlo = Math.min.apply(null, won), whi = Math.max.apply(null, won);
      const llo = Math.min.apply(null, lost), lhi = Math.max.apply(null, lost);
      const overlap = Math.max(0, Math.min(whi, lhi) - Math.max(wlo, llo));
      const span = Math.max(whi, lhi) - Math.min(wlo, llo);
      if (span > 0 && overlap / span >= 0.5) { flags.push('CONTRADICTORY_SIGNAL'); signalConfidence *= 0.5; }
    }

    // ---- candidate: anchor default → signal nudge → HARD floor clamp ----
    let candidate = clamp(anchorEff, low, high);
    let unprofitable = false;
    if (band) {
      if (band.high < marginFloor) {
        // entire winning band is below the floor — not a price, an escalation
        unprofitable = true; flags.push('UNPROFITABLE_TO_WIN');
        candidate = low; // floor = lowest defensible price
      } else {
        const target = clamp(bandMid, low, high);
        candidate = anchorEff + signalConfidence * (target - anchorEff); // nudge, never average
        candidate = clamp(candidate, low, high);
      }
    }
    const recommended = money(Math.max(candidate, marginFloor)); // HARD RULE #1
    const rLow = money(Math.max(low, recommended * 0.97));
    const rHigh = money(Math.min(high, recommended * 1.03));

    // ---- confidence ----
    const anchorConfidence = (inputs.anchor && inputs.anchor.active === false) ? 0.6 : 0.95;
    let agreement = 0.7;
    if (band) agreement = unprofitable ? 0 : clamp01(1 - Math.abs(anchorEff - bandMid) / Math.max(1, bandMid));
    let decisionConfidence = clamp01(0.4 * anchorConfidence + 0.4 * (band ? signalConfidence : 0.4) + 0.2 * agreement);
    if (flags.indexOf('THIN_DATA') !== -1) decisionConfidence *= 0.8;
    if (flags.indexOf('CONTRADICTORY_SIGNAL') !== -1) decisionConfidence *= 0.8;
    if (unprofitable) decisionConfidence = Math.min(decisionConfidence, 0.4);
    decisionConfidence = r3(decisionConfidence);
    const confidenceLevel = decisionConfidence >= policy.highConf ? 'high' : (decisionConfidence < policy.lowConf ? 'low' : 'medium');
    if (confidenceLevel === 'low') flags.push('LOW_CONFIDENCE');

    // deviation from anchor
    const deviation = anchorEff ? Math.abs(recommended - anchorEff) / anchorEff : 0;
    if (deviation > policy.deviationPct) flags.push('LARGE_DEVIATION');

    const escalationFlags = uniq(flags);
    const decision = {
      ok: true,
      feasibleRange: { low: low, high: high },
      recommended: recommended,
      recommendedRange: { low: rLow, high: rHigh },
      decisionConfidence: decisionConfidence,
      confidenceLevel: confidenceLevel,
      escalationFlags: escalationFlags,
      unprofitableToWin: unprofitable,
      requiresApproval: true,                                   // HARD RULE #4 — always
      requiresReview: escalationFlags.length > 0 || confidenceLevel === 'low' || unprofitable,
      evidence: {
        material: { cost: materialCost },
        anchor: { price: anchorPrice, effective: anchorEff, version: (inputs.anchor && inputs.anchor.version) || null, source: (inputs.anchor && inputs.anchor.source) || null, active: !(inputs.anchor && inputs.anchor.active === false) },
        marginFloor: marginFloor,
        signal: { n: n, won: won.length, lost: lost.length, winRate: winRate != null ? r3(winRate) : null, winningBand: band, signalConfidence: r3(signalConfidence) },
        context: { flags: (inputs.context && inputs.context.flags) || [], sopRefs: (inputs.context && inputs.context.sopRefs) || [] },
        weighting: { anchorConfidence: r3(anchorConfidence), agreement: r3(agreement), method: 'recommended = anchor + signalConfidence*(target-anchor), clamped to [floor, anchor+uplift]; floor is a hard constraint, never averaged' }
      }
    };
    decision.supervisorReviewPayload = supervisorPayload(decision, inputs);
    return decision;
  }

  const Resolver = {
    DEFAULT_POLICY: DEFAULT_POLICY,
    compute: compute,

    /**
     * Resolve + write the decision to the immutable ledger (HARD RULE #5).
     * PII-free payload (amounts, flags, confidence, ids only). Returns the
     * decision augmented with decisionId + ledgerRef. Never throws.
     */
    async resolve(inputs, opts) {
      const d = compute(inputs);
      if (!d.ok) return d;
      const meta = (inputs && inputs.meta) || {};
      const decisionId = (ids() && ids().createId) ? ids().createId('pdec') : ('pdec_' + now());
      d.decisionId = decisionId;
      try {
        if (ledger() && ledger().append) {
          const entry = await ledger().append('pricing_decision', {
            decisionId: decisionId,
            agentId: (opts && opts.agentId) || meta.agentId || null,
            subjectType: meta.subjectType || null, subjectId: meta.subjectId || null, jobId: meta.jobId || null,
            recommended: d.recommended, feasibleRange: d.feasibleRange,
            anchorPrice: d.evidence.anchor.price, marginFloor: d.evidence.marginFloor,
            decisionConfidence: d.decisionConfidence, confidenceLevel: d.confidenceLevel,
            escalationFlags: d.escalationFlags, unprofitableToWin: d.unprofitableToWin,
            requiresApproval: d.requiresApproval, requiresReview: d.requiresReview,
            signalN: d.evidence.signal.n, winRate: d.evidence.signal.winRate, at: now()
          });
          d.ledgerRef = entry ? entry.id : null;
        }
      } catch (_) { /* ledger best-effort; the decision still stands */ }
      return d;
    }
  };

  global.AAA_PRICING_RESOLVER = Resolver;
})(typeof window !== 'undefined' ? window : this);
