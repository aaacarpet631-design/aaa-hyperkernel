/*
 * AAA Policy Simulator — A/B a policy against reality without touching reality.
 *
 * Tests five policy families — pricing, dispatch, scheduling, marketing,
 * approval — by mapping each policy variant to a scenario the counterfactual
 * runner can evaluate, then comparing variants on the strategy scorecard. The
 * status-quo ("hold") variant is always included as the reference.
 *
 * Everything runs through the read-only runner, so a policy experiment can
 * never mutate production. Returns a ranked comparison the Executive Council
 * can act on (via simulation governance).
 */
;(function (global) {
  'use strict';

  function runner() { return global.AAA_COUNTERFACTUAL_RUNNER; }

  // policy family → how a variant's params map onto a scenario.
  const POLICIES = {
    pricing: function (v) { return { kind: 'price_change', params: { pct: v.pct || 0 } }; },
    marketing: function (v) { return { kind: 'ad_spend_change', params: { pct: v.pct || 0 } }; },
    dispatch: function (v) { return { kind: 'add_crew', params: { crews: v.crews || 0 } }; },
    scheduling: function (v) { return { kind: 'add_crew', params: { crews: v.crews || 0 } }; },
    approval: function (v) { return { kind: 'price_change', params: { pct: v.pct || 0 } }; }
  };

  const Simulator = {
    POLICIES: Object.keys(POLICIES),

    /**
     * Simulate variants of a policy family. variants: [{ label, ...params }].
     * opts: { seed, n, snapshot }. Returns { ok, policy, ranked:[{label, runId, card}] }.
     */
    async simulate(policy, variants, opts) {
      const o = opts || {};
      const map = POLICIES[policy];
      if (!map) return { ok: false, error: 'UNKNOWN_POLICY', policy: policy };
      const list = Array.isArray(variants) ? variants.slice() : [];
      // Always include the status quo as the reference variant.
      if (!list.some((v) => v.label === 'hold')) list.unshift({ label: 'hold' });
      const snapshot = o.snapshot || await runner().snapshot();

      const results = [];
      for (const v of list) {
        const spec = map(v);
        const res = await runner().run({ kind: spec.kind, params: spec.params, seed: o.seed == null ? (policy + ':' + v.label) : (o.seed + ':' + v.label), n: o.n || 1000, snapshot: snapshot, policy: { version: 'pol:' + policy + ':' + (v.label || 'v') } });
        if (res.ok) results.push({ label: v.label, variant: v, runId: res.runId, card: res.scorecard, scenario: res.scenario });
      }
      const ranked = results.sort((a, b) => ((b.card && b.card.score) || 0) - ((a.card && a.card.score) || 0));
      const hold = results.find((r) => r.label === 'hold');
      return { ok: true, policy: policy, reference: hold || null, ranked: ranked, best: ranked[0] || null };
    }
  };

  global.AAA_POLICY_SIMULATOR = Simulator;
})(typeof window !== 'undefined' ? window : this);
