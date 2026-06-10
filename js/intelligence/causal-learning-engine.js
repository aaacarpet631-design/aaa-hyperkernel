/*
 * AAA Causal Learning Engine — separates correlation from earned causation.
 *
 * evaluate(support, counter) is the pure inference rule: confidence is the
 * support fraction, and a hypothesis only earns `supported` after enough
 * observations with a strong, low-counter-evidence record; it earns `rejected`
 * when the evidence turns against it; otherwise it is `testing` (or `proposed`
 * before any evidence). This is the guard against "causality from correlation
 * alone": correlate() can measure how two signals move together, but it can
 * NEVER promote a hypothesis past `proposed` — only accumulated evidence can.
 */
;(function (global) {
  'use strict';

  const MIN_OBS = 8;          // minimum observations before supported/rejected
  const SUPPORT_CONF = 0.80;  // support fraction to be supported
  const MAX_COUNTER = 0.15;   // counter-evidence ceiling for supported
  const REJECT_CONF = 0.35;   // support fraction at/below which → rejected
  const REJECT_COUNTER = 0.45;// counter-evidence floor for rejected

  const Engine = {
    MIN_OBS: MIN_OBS,

    /** Pure status/confidence from evidence counts. */
    evaluate(support, counter) {
      const s = Math.max(0, support | 0); const c = Math.max(0, counter | 0);
      const total = s + c;
      if (total === 0) return { confidence: 0.5, status: 'proposed', evidenceCount: 0, counterEvidenceCount: 0, total: 0 };
      const confidence = s / total;
      let status;
      if (total >= MIN_OBS) {
        if (confidence >= SUPPORT_CONF && c <= total * MAX_COUNTER) status = 'supported';
        else if (confidence <= REJECT_CONF || c >= total * REJECT_COUNTER) status = 'rejected';
        else status = 'testing';
      } else {
        status = 'testing';
      }
      return { confidence: Math.round(confidence * 1e6) / 1e6, status: status, evidenceCount: s, counterEvidenceCount: c, total: total };
    },

    /** Pearson correlation of two equal-length numeric series, or null. */
    correlate(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b)) return null;
      const n = Math.min(a.length, b.length);
      if (n < 3) return null;
      let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
      if (da === 0 || db === 0) return null;
      return Math.round((num / Math.sqrt(da * db)) * 1e6) / 1e6;
    },

    /**
     * Measure correlation between two signal types from the world ledger and
     * return a *proposal only*. Correlation never implies causation here — the
     * returned object is always status:'proposed' with the observed r.
     */
    async suggestFromLedger(causeType, effectType) {
      const led = global.AAA_WORLD_STATE_LEDGER;
      if (!led) return null;
      const A = (await led.getRawLedger({ signalType: causeType })).map((r) => r.value).filter((v) => v != null);
      const B = (await led.getRawLedger({ signalType: effectType })).map((r) => r.value).filter((v) => v != null);
      const n = Math.min(A.length, B.length);
      const r = this.correlate(A.slice(-n), B.slice(-n));
      return { causeSignal: causeType, effectSignal: effectType, correlation: r, status: 'proposed', note: 'correlation is not causation — evidence required to advance' };
    }
  };

  global.AAA_CAUSAL_LEARNING_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
