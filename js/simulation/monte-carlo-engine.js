/*
 * AAA Monte Carlo Engine — thousands of randomized futures, bounded honestly.
 *
 * Given a baseline + scenario, it draws N seeded samples of the estimator's
 * uncertain coefficients and aggregates the resulting outcomes into:
 *   best case · expected case · worst case · confidence interval (p05/p50/p95)
 * both for a composite objective (revenue) and per metric.
 *
 * The PRNG is a seeded mulberry32, so a {scenario, baseline, seed, n} tuple
 * yields BIT-IDENTICAL results every time — the foundation of deterministic
 * replay. No I/O; pure computation.
 */
;(function (global) {
  'use strict';

  function estimator() { return global.AAA_OUTCOME_ESTIMATOR; }

  // Deterministic PRNG. String seeds are hashed to a 32-bit int first.
  function hashSeed(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return seed >>> 0;
    let h = 0x811c9dc5; const s = String(seed == null ? 'aaa' : seed);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function round(n, p) { const f = Math.pow(10, p == null ? 2 : p); return n == null ? null : Math.round(n * f) / f; }

  const Engine = {
    rng: function (seed) { return mulberry32(hashSeed(seed)); },
    hashSeed: hashSeed,

    /**
     * Run N samples. → {
     *   samples, seed, expected:{metric→mean}, best:{outcome}, worst:{outcome},
     *   ci:{ objective:{p05,p50,p95}, perMetric:{metric:{p05,p50,p95,min,max,mean}} },
     *   objective:'revenue'
     * }
     */
    run(baseline, scenario, opts) {
      const o = opts || {};
      const n = Math.max(1, Math.min(o.n || 1000, o.maxN || 20000));
      const est = estimator();
      const rng = mulberry32(hashSeed(o.seed));
      const metrics = est.METRICS;
      const series = {}; metrics.forEach((m) => { series[m] = []; });
      const objectiveKey = o.objective || 'revenue';
      let best = null, worst = null;

      for (let i = 0; i < n; i++) {
        const draw = est.sampleDraw(scenario, rng);
        const out = est.estimate(baseline, scenario, draw);
        metrics.forEach((m) => { series[m].push(out[m]); });
        const obj = out[objectiveKey];
        if (!best || obj > best._obj) best = Object.assign({ _obj: obj }, out);
        if (!worst || obj < worst._obj) worst = Object.assign({ _obj: obj }, out);
      }

      const expected = {}; const perMetric = {};
      metrics.forEach((m) => {
        const sorted = series[m].slice().sort((a, b) => a - b);
        expected[m] = round(mean(sorted), 4);
        perMetric[m] = { p05: round(percentile(sorted, 5), 4), p50: round(percentile(sorted, 50), 4), p95: round(percentile(sorted, 95), 4), min: round(sorted[0], 4), max: round(sorted[sorted.length - 1], 4), mean: round(mean(sorted), 4) };
      });
      const cleanBest = {}; const cleanWorst = {};
      metrics.forEach((m) => { cleanBest[m] = round(best[m], 4); cleanWorst[m] = round(worst[m], 4); });

      return {
        samples: n, seed: o.seed == null ? null : o.seed, objective: objectiveKey,
        expected: expected, best: cleanBest, worst: cleanWorst,
        ci: { objective: perMetric[objectiveKey], perMetric: perMetric }
      };
    }
  };

  global.AAA_MONTE_CARLO = Engine;
})(typeof window !== 'undefined' ? window : this);
