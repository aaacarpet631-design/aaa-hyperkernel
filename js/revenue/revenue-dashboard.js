/*
 * AAA Revenue Dashboard — read model for the Revenue Council (data, not UI).
 *
 * Assembles the council's headline numbers from the underlying engines:
 * lead quality, close probability, CAC, margin, review velocity, referral
 * velocity — each carrying its own status so the view can show
 * insufficient_data honestly instead of a flattering placeholder. Pure read.
 */
;(function (global) {
  'use strict';

  const G = (k) => global[k];
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  async function sig(type, now) { const wm = G('AAA_WORLD_MODEL'); if (!wm) return { value: null, status: 'unavailable' }; const s = await wm.signal(type, now); return { value: (s.status === 'fresh' || s.status === 'degraded') ? s.value : null, status: s.status, confidence: s.confidence }; }

  const Dashboard = {
    async view(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const market = G('AAA_MARKET_INTELLIGENCE') ? await G('AAA_MARKET_INTELLIGENCE').assess({ now: now }) : null;
      const flywheel = G('AAA_REVENUE_COUNCIL') ? await G('AAA_REVENUE_COUNCIL').flywheel({ now: now }) : null;
      const budget = G('AAA_BUDGET_PHYSICS_ENGINE') ? await G('AAA_BUDGET_PHYSICS_ENGINE').allocate(0) : null;
      const closeRate = await sig('close_rate', now);
      const margin = await sig('gross_margin', now);
      const govList = G('AAA_COUNCIL_GOVERNANCE') ? await G('AAA_COUNCIL_GOVERNANCE').list({ domain: 'revenue' }) : [];

      return {
        generatedAt: nowISO(),
        leadQuality: { demandIndex: market ? market.demandIndex : null, opportunityIndex: market ? market.opportunityIndex : null, status: market ? market.status : 'unavailable' },
        closeProbability: { value: closeRate.value, status: closeRate.status },
        cac: { value: null, status: 'insufficient_data', note: 'requires a marketing spend feed' },
        margin: { value: margin.value, status: margin.status },
        reviewVelocity: { perWeek: flywheel ? flywheel.velocityPerWeek : null, reviewProbability: flywheel ? flywheel.reviewProbability : null },
        referralVelocity: { referralProbability: flywheel ? flywheel.referralProbability : null },
        budgetAllocation: budget ? budget.allocations : [],
        recommendations: { pending: govList.filter((r) => r.status === 'pending_governance').length, approved: govList.filter((r) => r.status === 'approved' || r.status === 'applied').length }
      };
    }
  };

  global.AAA_REVENUE_DASHBOARD = Dashboard;
})(typeof window !== 'undefined' ? window : this);
