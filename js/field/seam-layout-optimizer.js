/*
 * AAA Seam & Layout Optimizer — turn captured rooms into a carpet cut plan.
 *
 * Field Brain captures reality; this turns reality into margin. It runs the five
 * passes over a capture session's rooms and emits a review-gated layout plan:
 *
 *   Pass 1  Nap Axis Resolver        global nap (or UNKNOWN → needsReview)
 *   Pass 2  Roll-Width Boxing        rooms → 12-ft drops (+ fill if > 12 ft), no rotation
 *   Pass 3  Fill-Piece Harvesting    fills sourced from compatible leftovers
 *   Pass 4  Seam Risk Analysis       narrow strips, nap conflict, missing thresholds…
 *   Pass 5  Quote Integration        linear feet, square yards, waste %, cut list, risk
 *
 * It NEVER auto-sends a quote or changes a price — every quote-impacting output
 * is `needsReview` until an estimator confirms it. Insufficient geometry returns
 * insufficient_data. The plan is persisted append-only. Deterministic.
 */
;(function (global) {
  'use strict';

  const ROLL_WIDTH_FT = 12;

  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function engine() { return global.AAA_LAYOUT_CONSTRAINT_ENGINE; }
  function cutGen() { return global.AAA_CUT_LIST_GENERATOR; }
  function riskAnalyzer() { return global.AAA_LAYOUT_RISK_ANALYZER; }
  function store() { return global.AAA_LAYOUT_PLAN_STORE; }
  function capture() { return global.AAA_FIELD_CAPTURE_SESSION; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function round(n) { return n == null ? null : Math.round(n * 100) / 100; }
  function riskBand(r) { return r >= 0.6 ? 'high' : (r >= 0.3 ? 'medium' : 'low'); }
  function reviewThreshold() { const v = cfg().flag ? cfg().flag('layoutRiskReviewThreshold', 0.3) : 0.3; const n = Number(v); return isFinite(n) ? n : 0.3; }

  const Optimizer = {
    ROLL_WIDTH_FT: ROLL_WIDTH_FT,

    /**
     * Optimize a layout. opts: { sessionId } (pull rooms from the capture
     * session) or { rooms }, plus { napDirection, persist:true }.
     */
    async optimize(opts) {
      const o = opts || {};
      let rooms = Array.isArray(o.rooms) ? o.rooms : null;
      if (!rooms && o.sessionId && capture()) { try { rooms = await capture().rooms(o.sessionId); } catch (_) { rooms = []; } }
      rooms = rooms || [];
      const assumptions = []; const warnings = [];

      // Need at least one room with real (length × width) geometry.
      const exact = rooms.filter(function (r) { return engine() && engine().dims(r) && engine().dims(r).exact; });
      if (!exact.length) {
        const plan = this._base(o, {
          globalNapDirection: 'UNKNOWN', totalLinearFeetOrdered: null, totalSquareYards: null,
          calculatedWastePercentage: null, confidence: 0, risk: 'unknown', needsReview: true,
          status: 'insufficient_data', assumptions: ['No room captured with length × width geometry.'],
          cuts: [], warnings: ['Capture at least one room (length × width) before laying out.']
        });
        return o.persist === false ? plan : await this._persist(plan);
      }

      // Pass 1 — nap.
      const nap = engine().resolveNap(rooms, o);
      if (nap.direction === 'UNKNOWN') { assumptions.push('Nap direction unresolved — boxed to minimize fill for estimate; confirm direction before cutting.'); }
      else assumptions.push('Nap direction ' + nap.direction + ' (' + nap.basis + ').');

      // Passes 2 & 3 — boxing + fill harvesting.
      const cl = cutGen().generate(rooms, nap.direction);
      if (cl.unboxable && cl.unboxable.length) warnings.push(cl.unboxable.length + ' room(s) lacked geometry and were skipped: ' + cl.unboxable.join(', '));

      // Pass 4 — risk.
      const ra = riskAnalyzer().analyze(cl.cuts, exact, nap, o);
      ra.warnings.forEach(function (w) { warnings.push(w); });

      // Pass 5 — quote integration numbers (review-gated; not applied).
      const linearFeet = cl.totalLinearFeetOrdered;
      const orderedSqFt = linearFeet * ROLL_WIDTH_FT;
      const usedSqFt = cl.usedSquareFeet;
      const wastePct = orderedSqFt > 0 ? round(((orderedSqFt - usedSqFt) / orderedSqFt) * 100) : null;
      const squareYards = round(orderedSqFt / 9);

      // Confidence: nap certainty × low risk × full geometry.
      const geomComplete = exact.length / rooms.length;
      const confidence = round(Math.max(0, Math.min(1, (0.4 + 0.6 * (nap.confidence || 0)) * (1 - ra.risk) * geomComplete)));
      const needsReview = nap.direction === 'UNKNOWN' || ra.risk >= reviewThreshold() || (cl.unboxable && cl.unboxable.length > 0) || true; // ALWAYS review-gated for quote impact

      const plan = this._base(o, {
        globalNapDirection: nap.direction,
        totalLinearFeetOrdered: linearFeet,
        totalSquareYards: squareYards,
        calculatedWastePercentage: wastePct,
        harvestedSquareFeet: cl.harvestedSquareFeet,
        confidence: confidence,
        risk: riskBand(ra.risk),
        riskScore: ra.risk,
        needsReview: needsReview,
        status: 'planned',
        assumptions: assumptions,
        cuts: cl.cuts,
        warnings: warnings
      });
      return o.persist === false ? plan : await this._persist(plan);
    },

    _base(o, fields) {
      const sid = o.sessionId || null;
      return Object.assign({
        layoutPlanId: newId('layout'),
        sessionId: sid,
        sourceCaptureSessionId: sid,
        rollWidthFt: ROLL_WIDTH_FT,
        provenanceId: newId('prov'),
        createdAt: nowISO()
      }, fields);
    },
    async _persist(plan) { if (!store()) return plan; const rec = await store().record(plan); return rec; }
  };

  global.AAA_SEAM_LAYOUT_OPTIMIZER = Optimizer;
})(typeof window !== 'undefined' ? window : this);
