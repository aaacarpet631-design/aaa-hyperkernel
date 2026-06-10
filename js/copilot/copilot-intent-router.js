/*
 * AAA Copilot Intent Router — classify an owner's plain-English question into
 * the system that should answer it.
 *
 * Deterministic keyword classification over twelve intents. Returns the routing
 * contract { intent, confidence, requiredCouncils, requiredData, riskLevel,
 * governanceRequired }. Low confidence on a protected (governance) intent must
 * NOT execute — the orchestrator returns a clarification instead. No model call;
 * pure and reproducible.
 */
;(function (global) {
  'use strict';

  // intent → { kw[], councils[], data[], risk, governance }
  // Order matters: earlier intents win ties (most specific first).
  const INTENTS = [
    ['governance_action', { kw: ['approve', 'apply the', 'change the price to', 'set price', 'send the', 'issue refund', 'refund', 'pay ', 'payroll', 'sign contract', 'file taxes', 'schedule the crew', 'dispatch', 'launch the campaign', 'change ad spend'], councils: ['governance'], data: ['council_recommendations'], risk: 'high', governance: true }],
    ['simulation_request', { kw: ['what happens if', 'what if', 'simulate', 'hire another crew', 'add a crew', 'raise prices', 'lower prices', 'fuel', 'if i raise', 'if we add', 'hurricane', 'cpc'], councils: ['simulation'], data: ['simulation'], risk: 'low', governance: false }],
    ['goal_request', { kw: ['add $', 'per month', 'increase close', 'increase revenue', 'reduce callbacks', 'grow revenue', 'hit a goal', 'target of', 'i want to', 'how do i add', 'how do i grow'], councils: ['teleological'], data: ['goal'], risk: 'medium', governance: false }],
    ['morning_briefing', { kw: ['morning', 'briefing', 'what should i do today', 'daily', 'start my day', "today's plan"], councils: ['executive'], data: ['briefing'], risk: 'low', governance: false }],
    ['risk_report', { kw: ['risk', 'risks', 'threat', 'threats', 'danger', 'exposure', 'what could go wrong'], councils: ['simulation', 'innovation', 'governance'], data: ['risks'], risk: 'low', governance: false }],
    ['opportunity_report', { kw: ['opportunity', 'opportunities', 'best opportunities', 'where to grow', 'biggest opportunities', 'new revenue'], councils: ['innovation', 'revenue'], data: ['opportunities'], risk: 'low', governance: false }],
    ['estimate_analysis', { kw: ['estimate', 'quote', 'lost the', 'why did we lose', 'win probability', 'close rate', 'bid'], councils: ['revenue'], data: ['estimate'], risk: 'low', governance: false }],
    ['customer_analysis', { kw: ['customer', 'review', 'reviews', 'satisfaction', 'referral', 'reputation', 'complaint'], councils: ['revenue'], data: ['customer'], risk: 'low', governance: false }],
    ['operations_analysis', { kw: ['operations', 'crew', 'crews', 'schedule', 'capacity', 'utilization', 'dispatch', 'route'], councils: ['simulation', 'teleological'], data: ['operations'], risk: 'low', governance: false }],
    ['revenue_analysis', { kw: ['revenue', 'money', 'how much did we make', 'sales', 'income', 'margin', 'profit', 'leads down', 'cac', 'leads'], councils: ['revenue'], data: ['revenue'], risk: 'low', governance: false }],
    ['business_status', { kw: ['how are we doing', 'this week', 'status', 'overview', 'how is the business', 'what should i do', 'whats up', "what's up", 'summary'], councils: ['revenue', 'innovation', 'simulation', 'teleological'], data: ['status'], risk: 'low', governance: false }]
  ];

  const Router = {
    INTENTS: INTENTS.map((i) => i[0]).concat(['unknown']),

    classify(text) {
      const t = String(text == null ? '' : text).toLowerCase();
      let best = null, bestHits = 0;
      INTENTS.forEach(function (pair) {
        const def = pair[1];
        const hits = def.kw.reduce(function (n, k) { return n + (t.indexOf(k) !== -1 ? 1 : 0); }, 0);
        if (hits > bestHits) { bestHits = hits; best = pair; }
      });
      if (!best) {
        return { intent: 'unknown', confidence: 0, requiredCouncils: [], requiredData: [], riskLevel: 'low', governanceRequired: false };
      }
      const def = best[1];
      // Confidence: saturating with hit count, capped; single weak hit stays modest.
      const confidence = Math.min(0.95, 0.4 + 0.25 * bestHits);
      return { intent: best[0], confidence: Math.round(confidence * 100) / 100, requiredCouncils: def.councils.slice(), requiredData: def.data.slice(), riskLevel: def.risk, governanceRequired: !!def.governance };
    }
  };

  global.AAA_COPILOT_INTENT_ROUTER = Router;
})(typeof window !== 'undefined' ? window : this);
