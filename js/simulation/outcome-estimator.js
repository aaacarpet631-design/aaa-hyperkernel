/*
 * AAA Outcome Estimator — transparent impact models for each scenario.
 *
 * Given a baseline, a scenario, and a DRAW of uncertain coefficients, it
 * estimates the impact on the seven enterprise metrics:
 *   revenue · margin · utilization · responseTime · callbacks · closeRate · csat
 *
 * The models are deliberately simple, documented elasticities — not a black
 * box. Every coefficient has a named range (sample) so the Monte Carlo engine
 * can explore uncertainty, and a midpoint (the expected case). estimate() is
 * PURE and DETERMINISTIC: identical (baseline, scenario, draw) → identical
 * outcomes, which is what makes replay exact.
 */
;(function (global) {
  'use strict';

  const METRICS = ['revenue', 'margin', 'utilization', 'responseTime', 'callbacks', 'closeRate', 'csat'];
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function pos(x) { return Math.max(0, x); }
  // Sample a coefficient: center ± half-width, where u∈[0,1) (u=0.5 → center).
  function band(u, center, halfWidth) { return center + (u - 0.5) * 2 * halfWidth; }

  const MODELS = {
    price_change: {
      sample: function (r) { return { elasticity: band(r(), -0.9, 0.4), passThrough: band(r(), 0.7, 0.15), csatSens: band(r(), 0.3, 0.15) }; },
      apply: function (b, p, d) {
        const closeRate = clamp01(b.closeRate * (1 + d.elasticity * p.pct));
        const volume = b.volume * (b.closeRate ? closeRate / b.closeRate : 1);
        const ticket = b.avgTicket * (1 + p.pct);
        return {
          revenue: pos(volume * ticket),
          margin: clamp01(b.margin + p.pct * (1 - b.margin) * d.passThrough),
          utilization: clamp01(b.utilization * (b.volume ? volume / b.volume : 1)),
          responseTime: b.responseTime,
          callbacks: b.callbacks,
          closeRate: closeRate,
          csat: clamp01(b.csat - Math.max(0, p.pct) * d.csatSens)
        };
      }
    },
    add_crew: {
      sample: function (r) { return { headroom: band(r(), 1.5, 0.25), marginDrag: band(r(), 0.02, 0.01), qualityGain: band(r(), 1.25, 0.15), satGain: band(r(), 0.03, 0.02), respNoise: band(r(), 1.0, 0.1) }; },
      apply: function (b, p, d) {
        const capFactor = b.crews > 0 ? (b.crews + p.crews) / b.crews : 1;
        const volume = Math.min(b.volume * d.headroom, b.volume * Math.max(0.1, capFactor));
        const capacity = b.utilization > 0 ? (b.volume / b.utilization) * Math.max(0.1, capFactor) : b.volume * capFactor;
        return {
          revenue: pos(volume * b.avgTicket),
          margin: clamp01(b.margin - 0.02 * p.crews * (d.marginDrag / 0.02)),
          utilization: clamp01(capacity ? volume / capacity : b.utilization),
          responseTime: pos(b.responseTime / Math.max(0.1, capFactor) * d.respNoise),
          callbacks: clamp01(b.callbacks / Math.max(0.5, d.qualityGain)),
          closeRate: b.closeRate,
          csat: clamp01(b.csat + 0.03 * p.crews * (d.satGain / 0.03) * 0.3)
        };
      }
    },
    drop_zip: {
      sample: function (r) { return { marginGain: band(r(), 0.01, 0.005) }; },
      apply: function (b, p, d) {
        const share = clamp01(p.share == null ? 0.1 : p.share);
        const volume = b.volume * (1 - share);
        return {
          revenue: pos(volume * b.avgTicket),
          margin: clamp01(b.margin + d.marginGain),
          utilization: clamp01(b.utilization * (1 - share)),
          responseTime: pos(b.responseTime * (1 - share * 0.2)),
          callbacks: b.callbacks,
          closeRate: b.closeRate,
          csat: b.csat
        };
      }
    },
    fuel_change: {
      sample: function (r) { return { fuelShare: band(r(), 0.06, 0.02) }; },
      apply: function (b, p, d) {
        return {
          revenue: b.revenue,
          margin: clamp01(b.margin - d.fuelShare * p.pct),
          utilization: b.utilization,
          responseTime: b.responseTime,
          callbacks: b.callbacks,
          closeRate: b.closeRate,
          csat: b.csat
        };
      }
    },
    ad_spend_change: {
      sample: function (r) { return { leadElasticity: band(r(), 0.5, 0.2), adShare: band(r(), 0.08, 0.03), qualityDrag: band(r(), 0.5, 0.3) }; },
      apply: function (b, p, d) {
        const volume = pos(b.volume * (1 + d.leadElasticity * p.pct));
        const closeRate = clamp01(b.closeRate * (1 - d.qualityDrag * Math.max(0, p.pct) * 0.1));
        const revenue = pos(volume * b.avgTicket * (b.closeRate ? closeRate / b.closeRate : 1));
        return {
          revenue: revenue,
          margin: clamp01(b.margin - d.adShare * p.pct * (volume > 0 ? b.volume / volume : 1)),
          utilization: clamp01(b.utilization * (b.volume ? volume / b.volume : 1)),
          responseTime: b.responseTime,
          callbacks: b.callbacks,
          closeRate: closeRate,
          csat: b.csat
        };
      }
    },
    disaster: {
      sample: function (r) { return { spike: band(r(), 2.0, 0.5), surgeCap: band(r(), 1.3, 0.2), respStrain: band(r(), 1.0, 0.3), callbackRise: band(r(), 0.5, 0.25), satHit: band(r(), 0.2, 0.1) }; },
      apply: function (b, p, d) {
        const demand = b.volume * (1 + p.severity * d.spike);
        const capacity = (b.utilization > 0 ? b.volume / b.utilization : b.volume) * d.surgeCap;
        const served = Math.min(demand, capacity);
        return {
          revenue: pos(served * b.avgTicket),
          margin: clamp01(b.margin - p.severity * 0.03),
          utilization: clamp01(capacity ? served / capacity : 1),
          responseTime: pos(b.responseTime * (capacity ? demand / capacity : 1) * d.respStrain),
          callbacks: clamp01(b.callbacks * (1 + p.severity * d.callbackRise)),
          closeRate: b.closeRate,
          csat: clamp01(b.csat - p.severity * d.satHit)
        };
      }
    }
  };

  const Estimator = {
    METRICS: METRICS.slice(),
    has(kind) { return !!MODELS[kind]; },

    /** Sample the uncertain coefficients for a scenario from an rng (u∈[0,1)). */
    sampleDraw(scenario, rng) {
      const m = MODELS[scenario.kind];
      return m ? m.sample(rng || (() => 0.5)) : {};
    },

    /** Deterministic point estimate. draw defaults to expected (midpoint). */
    estimate(baseline, scenario, draw) {
      const m = MODELS[scenario.kind];
      if (!m) return null;
      const d = draw || m.sample(() => 0.5);
      const out = m.apply(baseline, scenario.params || {}, d);
      out.draw = d;
      return out;
    },

    /** Deltas vs baseline for the reportable metrics (signed). */
    deltas(baseline, outcome) {
      const out = {};
      METRICS.forEach((k) => { out[k] = (outcome[k] || 0) - (baseline[k] || 0); });
      return out;
    }
  };

  global.AAA_OUTCOME_ESTIMATOR = Estimator;
})(typeof window !== 'undefined' ? window : this);
