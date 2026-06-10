/*
 * AAA Copilot Observatory Read Model — the "what is the org doing?" screen.
 *
 * A pure read model over councils, recommendations, simulations, capability
 * gaps, and pending governance. No mutation; honest insufficient_data.
 */
;(function (global) {
  'use strict';

  const G = function (k) { return global[k]; };
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  async function safe(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  const Dashboard = {
    async view(opts) {
      const o = opts || {};
      const councils = [
        { name: 'Revenue', available: !!G('AAA_REVENUE_COUNCIL') },
        { name: 'Innovation', available: !!G('AAA_INNOVATION_COUNCIL') },
        { name: 'Simulation', available: !!G('AAA_COUNTERFACTUAL_RUNNER') },
        { name: 'Teleological', available: !!G('AAA_TELEOLOGICAL_GOAL_ENGINE') },
        { name: 'Scientific Discovery', available: !!G('AAA_SCIENTIFIC_DISCOVERY_COUNCIL') },
        { name: 'Genesis Foundry', available: !!G('AAA_GENESIS_COUNCIL') }
      ];
      const recommendations = G('AAA_COUNCIL_GOVERNANCE') ? await safe(function () { return G('AAA_COUNCIL_GOVERNANCE').list({}); }, []) : [];
      const sims = G('AAA_SIM_LEDGER') ? await safe(function () { return G('AAA_SIM_LEDGER').runs(); }, []) : [];
      const capGaps = G('AAA_GAP_DETECTOR') ? await safe(function () { return G('AAA_GAP_DETECTOR').gaps(); }, []) : [];
      const know = G('AAA_KNOWLEDGE_COMPOUNDING_ENGINE') ? await safe(function () { return G('AAA_KNOWLEDGE_COMPOUNDING_ENGINE').assess(); }, null) : null;

      return {
        generatedAt: nowISO(),
        councils: councils,
        recommendations: { total: recommendations.length, pending: recommendations.filter(function (r) { return r.status === 'pending_governance'; }).length, approved: recommendations.filter(function (r) { return r.status === 'approved' || r.status === 'applied'; }).length },
        simulations: { total: sims.length, recent: sims.slice(0, 5).map(function (s) { return { kind: s.scenario && s.scenario.kind, at: s.createdAt }; }) },
        capabilityGaps: { open: (capGaps || []).filter(function (g) { return g.status === 'open'; }).length },
        knowledge: know ? { theories: know.counts && know.counts.theory, moatScore: know.moatScore, moatStatus: know.moatStatus } : { status: 'insufficient_data' },
        governancePending: recommendations.filter(function (r) { return r.status === 'pending_governance'; }).slice(0, o.limit || 10).map(function (r) { return { id: r.id, domain: r.domain, action: r.action }; })
      };
    }
  };

  global.AAA_COPILOT_DASHBOARD = Dashboard;
})(typeof window !== 'undefined' ? window : this);
