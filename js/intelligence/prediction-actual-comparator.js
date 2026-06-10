/*
 * AAA Prediction-Actual Comparator — grades strategic predictions against
 * reality, immutably.
 *
 * Any predicted value (from a simulation or a strategic recommendation) can be
 * logged against the real outcome; the comparator appends a frozen delta
 * (absolute, percentage variance, accuracy = max(0, 1 − variance)) to an
 * append-only collection. Average accuracy feeds the Intelligence Scorecard,
 * and — when the hooks exist — the delta is fanned into simulation calibration
 * and capability reputation, so prediction quality compounds into the rest of
 * the kernel. Null predicted/actual are skipped (no fabricated accuracy).
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'prediction_deltas';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach((k) => deepFreeze(o[k])); Object.freeze(o); } return o; }
  function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }

  const Comparator = {
    COLLECTION: COLLECTION,

    /** Log a predicted-vs-actual comparison. Returns the frozen delta or null. */
    async logComparison(source, signalType, predicted, actual, meta) {
      const p = num(predicted); const a = num(actual);
      if (p == null || a == null) return null;
      const absoluteDelta = Math.abs(p - a);
      // Variance is measured against the PREDICTION (how far off the forecast was).
      const denom = Math.abs(p) > 1e-9 ? Math.abs(p) : (Math.abs(a) > 1e-9 ? Math.abs(a) : 1);
      const percentageVariance = absoluteDelta / denom;
      const id = newId('del');
      const rec = deepFreeze({ deltaId: id, workspaceId: ws(), source: source || null, signalType: signalType || null, predicted: p, actual: a, absoluteDelta: absoluteDelta, percentageVariance: percentageVariance, accuracy: Math.max(0, 1 - percentageVariance), recordedAt: nowISO() });
      await data().put(COLLECTION, id, rec);

      // Fan out to calibration / reputation when the hooks are present.
      const m = meta || {};
      try { if (m.capabilityRunId && global.AAA_CAPABILITY_LEDGER) await global.AAA_CAPABILITY_LEDGER.linkOutcome(m.capabilityRunId, { result: rec.accuracy >= 0.8 ? 'validated' : 'invalidated', roi: {}, note: 'prediction accuracy ' + Math.round(rec.accuracy * 100) + '%' }); } catch (_) {}
      return rec;
    },

    async deltas(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.signalType) all = all.filter((d) => d.signalType === f.signalType);
      if (f.source) all = all.filter((d) => d.source === f.source);
      return all.sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
    },

    /** Mean accuracy across logged deltas, or null when there are none. */
    async getAverageAccuracy(filter) {
      const all = await this.deltas(filter);
      if (!all.length) return null;
      return all.reduce((s, d) => s + d.accuracy, 0) / all.length;
    }
  };

  global.AAA_PREDICTION_COMPARATOR = Comparator;
})(typeof window !== 'undefined' ? window : this);
