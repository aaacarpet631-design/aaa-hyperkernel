/*
 * AAA Capability Reputation Store — a capability's track record, computed from
 * the immutable ledger and snapshot-able for trend.
 *
 * For a capability DNA signature it aggregates, from real ledger entries only:
 *   spawns · successRate · rollbackRate · avgRiskScore · avgCostUsd ·
 *   avgLatencyMs · avgConfidence · humanApprovals · graphFacts · toolBYOTs
 * and folds in the ROI engine's measurable-benefit verdict and the failure
 * detector's open-violation count. reputation() is read-through (always live,
 * never stale); snapshot() persists a dated copy so learning can watch a
 * capability improve or decay over time (like the analyst rankings).
 *
 * Risk is scored low=1 / medium=2 / high=3 so "average risk below threshold"
 * is a real number. Thin samples yield honest nulls, not flattering zeros.
 */
;(function (global) {
  'use strict';

  const SNAPSHOTS = 'capability_reputation_snapshots';
  const RISK_SCORE = { low: 1, medium: 2, high: 3 };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_CAPABILITY_LEDGER; }
  function roi() { return global.AAA_CAPABILITY_ROI; }
  function failures() { return global.AAA_FAILURE_DETECTOR; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

  const Store = {
    SNAPSHOTS: SNAPSHOTS, RISK_SCORE: RISK_SCORE,

    /** Live reputation for one signature, computed from the ledger. */
    async reputation(signature) {
      const entries = await ledger().entries({ signature: signature });
      const spawns = entries.length;
      const succeeded = entries.filter((e) => e.executionResult === 'succeeded').length;
      const rolledBack = entries.filter((e) => e.rollbackUsed).length;
      const riskScores = entries.map((e) => RISK_SCORE[e.risk] || 2);
      const confs = entries.map((e) => e.confidence).filter((c) => typeof c === 'number');
      const dna = entries.length ? entries[0].capabilityDNA : null;
      const name = entries.length && entries[0].agentSpec ? entries[0].agentSpec.name : null;

      const rep = {
        signature: signature, dna: dna, name: name,
        spawns: spawns,
        succeeded: succeeded,
        successRate: spawns ? succeeded / spawns : null,
        rollbacks: rolledBack,
        rollbackRate: spawns ? rolledBack / spawns : null,
        avgRiskScore: avg(riskScores),
        avgCostUsd: avg(entries.map((e) => Number(e.costUsd) || 0)),
        avgLatencyMs: avg(entries.map((e) => Number(e.latencyMs) || 0)),
        avgConfidence: avg(confs),
        humanApprovals: entries.filter((e) => e.humanApprovalRequired).length,
        graphFacts: entries.reduce((a, e) => a + (Number(e.graphFactsWritten) || 0), 0),
        toolBYOTs: entries.reduce((a, e) => a + (Array.isArray(e.toolSpec) ? e.toolSpec.filter((t) => t.byot).length : 0), 0),
        updatedAt: nowISO()
      };
      rep.roi = roi() ? await roi().compute(signature) : null;
      const fp = failures() ? await failures().scan(signature) : { violations: 0, openViolations: 0 };
      rep.openViolations = fp.openViolations != null ? fp.openViolations : (fp.violations || 0);
      rep.failurePatterns = fp.patterns || [];
      return rep;
    },

    /** Reputation for every signature seen. */
    async all() {
      const sigs = await ledger().signatures();
      const out = [];
      for (const s of sigs) out.push(await this.reputation(s.signature));
      return out;
    },

    /** Persist a dated reputation snapshot (trend, not truth — truth is the ledger). */
    async snapshot(signature) {
      const rep = await this.reputation(signature);
      const id = ids() ? ids().createId('repsnap') : 'repsnap_' + Date.now();
      const rec = Object.assign({ id: id, workspaceId: ws(), at: nowISO() }, rep);
      await data().put(SNAPSHOTS, id, rec);
      return rec;
    },

    async history(signature) {
      const all = (await data().list(SNAPSHOTS)).filter(mine).filter((s) => s.signature === signature);
      return all.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    }
  };

  global.AAA_CAPABILITY_REPUTATION = Store;
})(typeof window !== 'undefined' ? window : this);
