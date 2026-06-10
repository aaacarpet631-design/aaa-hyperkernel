/*
 * AAA Revenue Intelligence Council — the revenue-generation nervous system.
 *
 * Composes the six layers (Market Intelligence · Attention · Trust · Estimate
 * Intelligence · Decision Acceleration · Review Flywheel) into council-level
 * reads, and is the ONE place a revenue recommendation enters governance. The
 * council never mutates production and never bypasses approval: propose() routes
 * every recommendation through AAA_COUNCIL_GOVERNANCE, which emits
 * revenue.recommendation_proposed and requires a human to approve before any
 * policy change. Read-only over the business; deterministic composition.
 */
;(function (global) {
  'use strict';

  const G = (k) => global[k];

  const Council = {
    /** Market Intelligence layer. */
    async market(opts) { return G('AAA_MARKET_INTELLIGENCE') ? G('AAA_MARKET_INTELLIGENCE').assess(opts) : { status: 'unavailable' }; },

    /** Attention layer: classify a query's intent. */
    async intent(text, opts) { return G('AAA_SEARCH_INTENT_ENGINE') ? G('AAA_SEARCH_INTENT_ENGINE').classify(text, opts) : { status: 'unavailable' }; },

    /** Trust layer: friction + proof. */
    async trust(opts) { return G('AAA_TRUST_GAP_ENGINE') ? G('AAA_TRUST_GAP_ENGINE').assess(opts) : { status: 'unavailable' }; },

    /**
     * Estimate Intelligence: compose win probability, margin risk, and
     * objections into the layer's contract output.
     */
    async assessEstimate(estimate, opts) {
      const win = G('AAA_WIN_PROBABILITY_ENGINE') ? await G('AAA_WIN_PROBABILITY_ENGINE').winProbability(estimate) : null;
      const margin = G('AAA_MARGIN_GUARDIAN') ? await G('AAA_MARGIN_GUARDIAN').assess(estimate) : null;
      const obj = G('AAA_OBJECTION_FORECAST_ENGINE') ? await G('AAA_OBJECTION_FORECAST_ENGINE').forecast(estimate, opts) : null;
      let recommendation = 'Proceed.';
      if (margin && margin.underpriced) recommendation = 'Raise price toward the historical floor before sending — margin risk detected.';
      else if (win && win.winProbability != null && win.winProbability < 0.4) recommendation = 'Low close odds — lead with proof and a sharper value frame, or requalify.';
      else if (win && win.status === 'insufficient_data') recommendation = 'No comparable history yet — send, but log the outcome to build the model.';
      return {
        winProbability: win ? win.winProbability : null,
        marginRisk: margin ? margin.marginRisk : null,
        likelyObjections: obj ? obj.likelyObjections : [],
        recommendation: recommendation,
        confidence: win ? win.confidence : 0,
        detail: { win: win, margin: margin, objections: obj }
      };
    },

    /** Decision Acceleration: the next-touch plan for a lead/estimate. */
    async decisionPlan(record, now) { return G('AAA_FOLLOWUP_INTELLIGENCE') ? G('AAA_FOLLOWUP_INTELLIGENCE').sequence(record, now) : { status: 'unavailable' }; },

    /** Review Flywheel contract output. */
    async flywheel(opts) {
      const o = opts || {};
      const rv = G('AAA_REVIEW_VELOCITY_ENGINE') ? await G('AAA_REVIEW_VELOCITY_ENGINE').assess(o.now) : null;
      const rep = G('AAA_REPUTATION_ENGINE') ? await G('AAA_REPUTATION_ENGINE').assess(o.now) : null;
      let referralProbability = null;
      if (o.customerId && G('AAA_REFERRAL_ENGINE')) { const r = await G('AAA_REFERRAL_ENGINE').forCustomer(o.customerId); referralProbability = r.referralProbability; }
      else if (G('AAA_REFERRAL_ENGINE')) { const ops = await G('AAA_REFERRAL_ENGINE').opportunities(20); referralProbability = ops.length ? Math.round((ops.reduce((a, x) => a + x.referralProbability, 0) / ops.length) * 1000) / 1000 : null; }
      return { reviewProbability: rv ? rv.reviewProbability : null, referralProbability: referralProbability, reputationScore: rep ? rep.reputationScore : null, velocityPerWeek: rv ? rv.velocityPerWeek : null };
    },

    /**
     * Propose a revenue recommendation INTO governance. Returns the pending
     * record; nothing is applied until a human approves. This is the only
     * mutation path out of the council, and it mutates only the governance
     * recommendation ledger.
     */
    async propose(rec) {
      const gov = G('AAA_COUNCIL_GOVERNANCE');
      if (!gov) return { ok: false, error: 'GOVERNANCE_UNAVAILABLE' };
      return gov.propose('revenue', Object.assign({ council: 'revenue' }, rec || {}));
    }
  };

  global.AAA_REVENUE_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
