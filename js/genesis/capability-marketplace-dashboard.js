/*
 * AAA Capability Marketplace Dashboard — the read model of the economy.
 *
 * NOT cosmetic UI: a pure data assembler over the ledger, reputation store,
 * ROI engine, promotion scorer, failure detector, and banned registry. It
 * returns one structured object the Executive Council (or any view) can render:
 *
 *   topPromotedCandidates · riskyCapabilities · bannedCapabilities ·
 *   costliestCapabilities · highestRoiCapabilities · mostSpawnedDNA · totals
 *
 * Read-only and deterministic; it computes nothing the underlying engines don't
 * already vouch for. A UI layer can come later — this is the contract it binds to.
 */
;(function (global) {
  'use strict';

  function reputation() { return global.AAA_CAPABILITY_REPUTATION; }
  function roi() { return global.AAA_CAPABILITY_ROI; }
  function scorer() { return global.AAA_PROMOTION_SCORER; }
  function failures() { return global.AAA_FAILURE_DETECTOR; }
  function banned() { return global.AAA_BANNED_CAPABILITIES; }

  function top(list, n, key) { return list.slice().sort((a, b) => (key(b) || 0) - (key(a) || 0)).slice(0, n || 5); }

  const Dashboard = {
    /** Assemble the full marketplace view. `limit` caps each list (default 5). */
    async view(opts) {
      const o = opts || {};
      const n = o.limit || 5;
      const reps = reputation() ? await reputation().all() : [];

      const candidates = scorer() ? await scorer().candidates() : [];
      const risky = failures() ? await failures().scanAll() : [];
      const bannedList = banned() ? await banned().list() : [];
      const roiBoard = roi() ? await roi().leaderboard() : [];

      const mostSpawned = top(reps, n, (r) => r.spawns).map((r) => ({ signature: r.signature, name: r.name, dna: r.dna, spawns: r.spawns }));
      const costliest = top(reps, n, (r) => (r.avgCostUsd || 0) * (r.spawns || 0)).map((r) => ({ signature: r.signature, name: r.name, totalCostUsd: Math.round(((r.avgCostUsd || 0) * (r.spawns || 0)) * 10000) / 10000, avgCostUsd: r.avgCostUsd, spawns: r.spawns }));

      const totalRuns = reps.reduce((a, r) => a + (r.spawns || 0), 0);
      const totalCost = reps.reduce((a, r) => a + (r.avgCostUsd || 0) * (r.spawns || 0), 0);

      return {
        generatedAt: (global.AAA_RUNTIME_CLOCK && global.AAA_RUNTIME_CLOCK.nowISO) ? global.AAA_RUNTIME_CLOCK.nowISO() : new Date().toISOString(),
        totals: {
          capabilities: reps.length,
          runs: totalRuns,
          totalCostUsd: Math.round(totalCost * 10000) / 10000,
          promotable: candidates.length,
          risky: risky.length,
          banned: bannedList.length
        },
        topPromotedCandidates: candidates.slice(0, n).map((c) => ({ signature: c.signature, name: c.name, dna: c.dna, score: c.score, roiScore: c.reputation.roi ? c.reputation.roi.score : null, spawns: c.reputation.spawns })),
        highestRoiCapabilities: roiBoard.slice(0, n).map((r) => ({ signature: r.signature, name: r.name, score: r.score, dimensions: r.dimensions, money: r.money })),
        costliestCapabilities: costliest,
        riskyCapabilities: risky.slice(0, n).map((r) => ({ signature: r.signature, name: r.name, recommendation: r.recommendation, violations: r.violations, patterns: r.patterns.map((p) => p.kind) })),
        bannedCapabilities: bannedList.slice(0, n).map((b) => ({ signature: b.signature, state: b.state, reason: b.reason, source: b.source })),
        mostSpawnedDNA: mostSpawned
      };
    }
  };

  global.AAA_CAPABILITY_DASHBOARD = Dashboard;
})(typeof window !== 'undefined' ? window : this);
