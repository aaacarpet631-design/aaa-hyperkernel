/*
 * AAA Innovation Dashboard — read model for the Innovation Council (data only).
 *
 * Opportunities discovered, experiments running, projected ROI (from registered
 * opportunities' simulated projections), and validated vs rejected counts. Pure
 * read over the opportunity registry, experiment scorecard, and council
 * governance. Honest statuses; no flattering placeholders.
 */
;(function (global) {
  'use strict';

  const G = (k) => global[k];
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const Dashboard = {
    async view(opts) {
      const o = opts || {};
      const reg = G('AAA_OPPORTUNITY_REGISTRY');
      const opps = reg ? await reg.list() : [];
      const experiments = G('AAA_EXPERIMENT_SCORECARD') ? await G('AAA_EXPERIMENT_SCORECARD').portfolio() : { status: 'unavailable' };
      const gov = G('AAA_COUNCIL_GOVERNANCE') ? await G('AAA_COUNCIL_GOVERNANCE').list({ domain: 'innovation' }) : [];

      const margins = opps.map((p) => p.expectedMargin).filter((m) => m != null);
      const n = o.limit || 5;
      return {
        generatedAt: nowISO(),
        opportunitiesDiscovered: opps.length,
        topOpportunities: opps.slice(0, n).map((p) => ({ id: p.id, opportunity: p.opportunity, expectedMargin: p.expectedMargin, confidence: p.confidence, status: p.status })),
        validated: opps.filter((p) => p.status === 'validated').length,
        rejected: opps.filter((p) => p.status === 'rejected').length,
        simulating: opps.filter((p) => p.status === 'simulating').length,
        projectedMargin: { meanExpectedMargin: margins.length ? Math.round((margins.reduce((a, b) => a + b, 0) / margins.length) * 1000) / 1000 : null, status: margins.length ? 'estimate' : 'insufficient_data' },
        experiments: experiments,
        recommendations: { pending: gov.filter((r) => r.status === 'pending_governance').length, approved: gov.filter((r) => r.status === 'approved' || r.status === 'applied').length }
      };
    }
  };

  global.AAA_INNOVATION_DASHBOARD = Dashboard;
})(typeof window !== 'undefined' ? window : this);
