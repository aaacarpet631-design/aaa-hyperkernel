/*
 * AAA Market Intelligence — the Market Intelligence layer's synthesis.
 *
 * Composes the demand pulse, neighborhood opportunity, and competitor pressure
 * engines into the layer's contract output:
 *   { marketScore, demandIndex, opportunityIndex, confidence }
 *
 * marketScore rewards demand × opportunity and discounts competitive pressure.
 * Confidence is the mean of the contributing engines' confidences — and where a
 * contributor is insufficient_data it lowers confidence rather than inventing a
 * value. Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function demand() { return global.AAA_DEMAND_PULSE_ENGINE; }
  function neighborhood() { return global.AAA_NEIGHBORHOOD_OPPORTUNITY_ENGINE; }
  function competitor() { return global.AAA_COMPETITOR_INTELLIGENCE; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function r3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  const Market = {
    /** The Market Intelligence layer output for a market (zip optional). */
    async assess(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const pulse = demand() ? await demand().pulse(now) : { demandIndex: null, confidence: 0 };
      const opp = neighborhood() ? await neighborhood().opportunityIndex() : { value: null, confidence: 0 };
      const comp = competitor() ? await competitor().pressure(o.zip) : { competitorPressure: null, confidence: 0 };

      const demandIndex = pulse.demandIndex;
      const opportunityIndex = opp.value;
      const pressure = comp.competitorPressure == null ? 0 : comp.competitorPressure;

      let marketScore = null;
      if (demandIndex != null && opportunityIndex != null) {
        marketScore = r3(Math.max(0, Math.min(1, (0.5 * demandIndex + 0.5 * opportunityIndex) * (1 - 0.4 * pressure))));
      }
      const confs = [pulse.confidence, opp.confidence, comp.confidence].filter((c) => typeof c === 'number' && c > 0);
      const confidence = confs.length ? r3(mean(confs)) : 0;

      return {
        marketScore: marketScore,
        demandIndex: r3(demandIndex),
        opportunityIndex: r3(opportunityIndex),
        confidence: confidence,
        status: marketScore == null ? 'insufficient_data' : 'derived',
        components: { demand: pulse, opportunity: opp, competitor: comp }
      };
    }
  };

  global.AAA_MARKET_INTELLIGENCE = Market;
})(typeof window !== 'undefined' ? window : this);
