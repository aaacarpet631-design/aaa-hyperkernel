/*
 * AAA Counterfactual Runner — runs one full "what if" against a frozen reality.
 *
 * Flow:
 *   1. snapshot()      READ-ONLY copy of the source graph + a content hash
 *   2. resolve versions calibration + policy in force (provenance)
 *   3. build scenario  immutable spec + assumptions (scenario engine)
 *   4. baseline        derived from the snapshot (never live re-reads)
 *   5. monte carlo     N seeded futures → best/expected/worst + CI
 *   6. record          immutable simulation-ledger entry
 *
 * Production isolation is structural: the runner only READS production
 * collections and only WRITES sim_*. replay(runId) re-runs from the stored
 * scenario + seed + snapshot baseline and yields identical outcomes — the
 * deterministic-replay guarantee.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function scenarios() { return global.AAA_SCENARIO_ENGINE; }
  function monte() { return global.AAA_MONTE_CARLO; }
  function ledger() { return global.AAA_SIM_LEDGER; }
  function scorecard() { return global.AAA_STRATEGY_SCORECARD; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function canonical(v) { if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v); if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; }
  function cyrb(str) { let h = 0x811c9dc5; const s = String(str); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }

  function calibrationVersion() {
    const c = global.AAA_CALIBRATION_REGISTRY;
    try { if (c && c.activeVersion) return c.activeVersion(); } catch (_) {}
    return (cfg().flag ? cfg().flag('calibrationVersion', 'cal_v0') : 'cal_v0');
  }
  function policyVersionOf(policy) {
    if (policy && policy.version) return policy.version;
    return (cfg().flag ? cfg().flag('policyVersion', 'pol_v0') : 'pol_v0');
  }

  const Runner = {
    /** READ-ONLY snapshot of the source graph + a deterministic content hash. */
    async snapshot() {
      const d = data();
      const read = async (c) => { try { return await d.list(c); } catch (_) { return []; } };
      const source = {
        quotes: await read('quotes'),
        jobs: await read('jobs'),
        outcomes: await read('outcomes'),
        customers: await read('customers')
      };
      const counts = { quotes: source.quotes.length, jobs: source.jobs.length, outcomes: source.outcomes.length, customers: source.customers.length };
      return { at: nowISO(), hash: cyrb(canonical({ c: counts, q: source.quotes.map((q) => [q.id, q.status, q.total]) })), counts: counts, source: source };
    },

    /**
     * Run a counterfactual. opts: { kind, params, seed, n, policy }.
     * Returns { ok, runId, scenario, baseline, outcomes, scorecard }.
     */
    async run(opts) {
      const o = opts || {};
      const sc = scenarios().build(o.kind, o.params);
      if (!sc.ok) return sc;
      const snap = o.snapshot || await this.snapshot();
      const baseline = scenarios().baseline(snap);
      // drop_zip can compute its share from the snapshot if not supplied.
      if (sc.scenario.kind === 'drop_zip' && sc.scenario.params.share == null) {
        const share = scenarios().zipShare(snap, sc.scenario.params.zip);
        sc.scenario.params.share = share == null ? 0.1 : share;
      }
      const seed = o.seed == null ? 'aaa-' + sc.scenario.kind : o.seed;
      const outcomes = monte().run(baseline, sc.scenario, { seed: seed, n: o.n || 1000 });

      let card = null;
      try { if (scorecard()) card = scorecard().score(baseline, outcomes); } catch (_) {}

      const rec = await ledger().record({
        scenario: sc.scenario, assumptions: sc.scenario.assumptions,
        snapshot: { hash: snap.hash, counts: snap.counts, baseline: baseline },
        calibrationVersion: calibrationVersion(), policyVersion: policyVersionOf(o.policy),
        seed: seed, samples: outcomes.samples, outcomes: outcomes, scorecard: card
      });

      try { if (global.AAA_EVENT_BUS) await global.AAA_EVENT_BUS.publish('simulation.completed', { runId: rec.id, kind: sc.scenario.kind, seed: seed }, { source: 'simulation' }); } catch (_) {}
      return { ok: true, runId: rec.id, scenario: sc.scenario, baseline: baseline, outcomes: outcomes, scorecard: card, snapshot: { hash: snap.hash, counts: snap.counts } };
    },

    /**
     * Deterministic replay: re-run a stored simulation from its scenario +
     * seed + the baseline captured in its snapshot. Identical outcomes.
     */
    async replay(runId) {
      const run = await ledger().get(runId);
      if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
      const baseline = run.snapshot && run.snapshot.baseline;
      if (!baseline) return { ok: false, error: 'NO_BASELINE' };
      const outcomes = monte().run(baseline, run.scenario, { seed: run.seed, n: run.samples });
      return { ok: true, runId: runId, outcomes: outcomes, matches: JSON.stringify(outcomes) === JSON.stringify(run.outcomes) };
    }
  };

  global.AAA_COUNTERFACTUAL_RUNNER = Runner;
})(typeof window !== 'undefined' ? window : this);
