/*
 * AAA Capability ROI Engine — does this capability pay for itself?
 *
 * Reads the immutable ledger + its outcome overlays and aggregates the ROI a
 * capability has actually delivered across seven enterprise dimensions:
 *
 *   savedLaborMs · callbackRiskReduced · quoteAccuracyImproved ·
 *   closeRateIncreased · materialWasteReduced · schedulingEfficiencyImproved ·
 *   customerResponseTimeReduced
 *
 * Plus the money lines (savedUsd, revenueUsd, errorsAvoided) used by the
 * promotion scorer's "measurable benefit" rule. A dimension with no data is
 * `null` (unproven), never 0 — the same honesty rule the analyst rankings use:
 * a new capability is unproven, not worthless. Pure and deterministic; it
 * mutates nothing.
 */
;(function (global) {
  'use strict';

  function ledger() { return global.AAA_CAPABILITY_LEDGER; }

  // dimension key → { from: outcome.roi field, dir: 'higher'|'lower' is better }
  const DIMENSIONS = {
    savedLaborMs: { roi: 'savedMs', dir: 'higher' },
    callbackRiskReduced: { roi: 'callbackRiskDelta', dir: 'lower' },
    quoteAccuracyImproved: { roi: 'quoteAccuracyDelta', dir: 'higher' },
    closeRateIncreased: { roi: 'closeRateDelta', dir: 'higher' },
    materialWasteReduced: { roi: 'materialWasteDelta', dir: 'lower' },
    schedulingEfficiencyImproved: { roi: 'schedulingEfficiencyDelta', dir: 'higher' },
    customerResponseTimeReduced: { roi: 'responseTimeDelta', dir: 'lower' }
  };
  const MONEY = ['savedUsd', 'revenueUsd', 'errorsAvoided'];

  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  const Engine = {
    DIMENSIONS: Object.keys(DIMENSIONS),

    /**
     * ROI for one capability signature. Aggregates every outcome overlay tied
     * to that signature's runs. A benefit is "measurable" when any dimension or
     * money line nets out positive (a "lower-is-better" delta counts when the
     * recorded delta is negative — i.e. the metric went down).
     */
    async compute(signature) {
      const entries = await ledger().entries({ signature: signature });
      const runIds = {}; entries.forEach((e) => { runIds[e.runId] = true; });
      const outcomes = (await ledger().outcomes()).filter((o) => runIds[o.runId]);

      const dims = {};
      Object.keys(DIMENSIONS).forEach((k) => { dims[k] = null; });
      const money = {}; MONEY.forEach((k) => { money[k] = null; });
      let samples = 0;

      outcomes.forEach((o) => {
        const roi = o.roi || {};
        let touched = false;
        Object.keys(DIMENSIONS).forEach((k) => {
          const raw = num(roi[DIMENSIONS[k].roi]);
          if (raw == null) return;
          touched = true;
          // Normalize to "benefit delivered" (positive = good) regardless of direction.
          const benefit = DIMENSIONS[k].dir === 'lower' ? -raw : raw;
          dims[k] = (dims[k] || 0) + benefit;
        });
        MONEY.forEach((k) => { const raw = num(roi[k]); if (raw != null) { money[k] = (money[k] || 0) + raw; touched = true; } });
        if (touched) samples++;
      });

      const measurableBenefit =
        Object.keys(dims).some((k) => dims[k] != null && dims[k] > 0) ||
        MONEY.some((k) => money[k] != null && money[k] > 0);

      // A single comparable score: money + a modest credit for labor minutes saved.
      const score = (money.savedUsd || 0) + (money.revenueUsd || 0) + ((dims.savedLaborMs || 0) / 60000) * 0.5;

      return { signature: signature, samples: samples, dimensions: dims, money: money, measurableBenefit: measurableBenefit, score: Math.round(score * 100) / 100 };
    },

    /** ROI for every signature seen, richest first. */
    async leaderboard() {
      const sigs = await ledger().signatures();
      const out = [];
      for (const s of sigs) out.push(Object.assign({ dna: s.dna, name: s.name }, await this.compute(s.signature)));
      return out.sort((a, b) => b.score - a.score);
    }
  };

  global.AAA_CAPABILITY_ROI = Engine;
})(typeof window !== 'undefined' ? window : this);
