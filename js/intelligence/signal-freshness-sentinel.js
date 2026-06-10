/*
 * AAA Signal Freshness Sentinel — stale signals must not silently drive
 * high-confidence simulations.
 *
 * assess(entry, now, opts) classifies a signal record against its expiry and
 * stale policy:
 *   value === null            → insufficient_data (never fabricate)
 *   fresh (now ≤ expiresAt)   → fresh, full confidence
 *   stale + 'block'           → blocked (value withheld)
 *   stale + 'require_override'→ requires_override unless opts.override, then degraded
 *   stale + 'degrade_confidence' → entropy decay: confidence × exp(−volatility·hoursStale);
 *                                  below MIN_CONFIDENCE it collapses to insufficient_data
 *
 * Pure and deterministic; the decay is a function of the record + the clock only.
 */
;(function (global) {
  'use strict';

  const MIN_CONFIDENCE = 0.05;

  function ms(iso) { const t = Date.parse(iso); return isFinite(t) ? t : null; }

  const Sentinel = {
    MIN_CONFIDENCE: MIN_CONFIDENCE,

    /** @returns {status, value, confidence, decayFactor?, hoursStale?} */
    assess(entry, now, opts) {
      const o = opts || {};
      if (!entry) return { status: 'insufficient_data', value: null, confidence: 0 };
      if (entry.value === null || entry.value === undefined) return { status: 'insufficient_data', value: null, confidence: 0 };

      const ref = now != null ? (typeof now === 'number' ? now : ms(now)) : Date.now();
      const exp = ms(entry.expiresAt);
      if (exp == null || ref <= exp) {
        return { status: 'fresh', value: entry.value, confidence: entry.confidence, entry: entry };
      }

      // Stale from here down.
      const policy = entry.stalePolicy || 'degrade_confidence';
      if (policy === 'block') return { status: 'blocked', value: null, confidence: 0, entry: entry };

      const hoursStale = (ref - exp) / 3600000;
      const decayFactor = Math.exp(-(entry.volatility || 0) * hoursStale);
      const degraded = entry.confidence * decayFactor;

      if (policy === 'require_override' && !o.override) {
        return { status: 'requires_override', value: null, confidence: 0, hoursStale: hoursStale, entry: entry };
      }
      if (degraded < MIN_CONFIDENCE) return { status: 'insufficient_data', value: null, confidence: 0, hoursStale: hoursStale, entry: entry };
      return { status: 'degraded', value: entry.value, confidence: degraded, decayFactor: decayFactor, hoursStale: hoursStale, entry: entry };
    },

    /** Can a simulation rely on this assessment at the requested confidence floor? */
    usableForSimulation(assessed, minConfidence) {
      const floor = minConfidence == null ? 0.2 : minConfidence;
      if (!assessed) return false;
      if (assessed.status === 'fresh') return true;
      if (assessed.status === 'degraded') return assessed.confidence >= floor;
      return false; // blocked / requires_override / insufficient_data
    }
  };

  global.AAA_SIGNAL_FRESHNESS_SENTINEL = Sentinel;
})(typeof window !== 'undefined' ? window : this);
