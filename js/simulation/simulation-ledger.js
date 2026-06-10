/*
 * AAA Simulation Ledger — the immutable record of every counterfactual.
 *
 * Simulation is how the kernel learns before reality. Like the audit and
 * capability ledgers, this is APPEND-ONLY: a simulation run is never mutated,
 * and the eventual real-world result arrives as a SEPARATE append
 * (sim_actuals), so "what did we predict, with what assumptions, and how did
 * reality compare?" is always answerable.
 *
 * Every run records the directive's required fields:
 *   assumptions · input graph snapshot (hash + counts + baseline) ·
 *   calibration version · policy version · random seed · generated outcomes.
 *
 * Pure storage; writes ONLY simulation collections (never production). The
 * separate ledger is itself the production-isolation guarantee.
 */
;(function (global) {
  'use strict';

  const RUNS = 'sim_runs';
  const RECS = 'sim_recommendations';
  const ACTUALS = 'sim_actuals';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }

  const Ledger = {
    RUNS: RUNS, RECS: RECS, ACTUALS: ACTUALS,

    /** Append one immutable simulation run. Returns the stored record. */
    async record(run) {
      const r = run || {};
      const id = newId('sim');
      const rec = {
        id: id, workspaceId: ws(),
        scenario: r.scenario || null,
        assumptions: Array.isArray(r.assumptions) ? r.assumptions : [],
        snapshot: r.snapshot || null,            // { hash, counts, baseline }
        calibrationVersion: r.calibrationVersion || null,
        policyVersion: r.policyVersion || null,
        seed: r.seed != null ? r.seed : null,
        samples: r.samples != null ? r.samples : null,
        outcomes: r.outcomes || null,            // monte-carlo result
        scorecard: r.scorecard || null,
        createdAt: nowISO()
      };
      await data().put(RUNS, id, rec);
      return rec;
    },

    async get(id) { const r = await data().get(RUNS, id); return mine(r) ? r : null; },

    async runs(filter) {
      const f = filter || {};
      let all = (await data().list(RUNS)).filter(mine);
      if (f.kind) all = all.filter((r) => r.scenario && r.scenario.kind === f.kind);
      return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    /** A simulation-driven recommendation awaiting governance (see sim governance). */
    async recordRecommendation(rec) {
      const id = newId('simrec');
      const r = Object.assign({ id: id, workspaceId: ws(), status: 'pending_governance', createdAt: nowISO() }, rec || {});
      await data().put(RECS, id, r);
      return r;
    },
    async recommendation(id) { const r = await data().get(RECS, id); return mine(r) ? r : null; },
    async recommendations() { return (await data().list(RECS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async updateRecommendation(id, patch) { const r = await data().get(RECS, id); if (!r) return null; const u = Object.assign({}, r, patch || {}); await data().put(RECS, id, u); return u; },

    /** Append-only real-world outcome for a simulation run (the learning input). */
    async recordActual(actual) {
      const id = newId('simact');
      const r = Object.assign({ id: id, workspaceId: ws(), createdAt: nowISO() }, actual || {});
      await data().put(ACTUALS, id, r);
      return r;
    },
    async actuals(runId) { const all = (await data().list(ACTUALS)).filter(mine); return runId ? all.filter((a) => a.runId === runId) : all; }
  };

  global.AAA_SIM_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
