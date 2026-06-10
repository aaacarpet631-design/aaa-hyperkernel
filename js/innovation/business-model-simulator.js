/*
 * AAA Business Model Simulator — test new revenue models before reality.
 *
 * Integrates directly with the Simulation Council: for each business model it
 * (a) builds a deterministic recurring-revenue projection anchored to REAL
 * customer/job counts and the World Model's margin signal, and (b) runs a
 * Counterfactual Runner scenario for the demand/price sensitivity, attaching the
 * immutable sim runId. NO PRODUCTION MUTATION — it only reads the business and
 * writes to the simulation ledger via the runner. Assumptions are explicit.
 *
 * Models: maintenance_membership · annual_service_plan ·
 * premium_response_guarantee · commercial_contracts · subscription.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function runner() { return global.AAA_COUNTERFACTUAL_RUNNER; }
  function world() { return global.AAA_WORLD_MODEL; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  // model → { scenario (Sim Council kind+params for sensitivity), project(ctx) }
  const MODELS = {
    maintenance_membership: { scenario: { kind: 'ad_spend_change', params: { pct: 0.0 } }, monthly: 'membershipMonthlyFee', uptake: 'membershipUptake' },
    annual_service_plan: { scenario: { kind: 'price_change', params: { pct: 0.0 } }, monthly: 'annualPlanMonthly', uptake: 'annualPlanUptake' },
    premium_response_guarantee: { scenario: { kind: 'price_change', params: { pct: 0.1 } }, monthly: 'premiumMonthly', uptake: 'premiumUptake' },
    commercial_contracts: { scenario: { kind: 'add_crew', params: { crews: 1 } }, monthly: 'commercialMonthly', uptake: 'commercialUptake' },
    subscription: { scenario: { kind: 'ad_spend_change', params: { pct: 0.0 } }, monthly: 'subscriptionMonthly', uptake: 'subscriptionUptake' }
  };

  const Sim = {
    MODELS: Object.keys(MODELS),

    /** Project + simulate one business model. opts: { assumptions, seed, n }. */
    async simulate(model, opts) {
      const o = opts || {};
      const m = MODELS[model];
      if (!m) return { ok: false, error: 'UNKNOWN_MODEL', model: model };
      const now = o.now != null ? o.now : nowMs();
      const customers = (await list('customers')).length;
      const a = o.assumptions || {};
      const monthlyFee = num(a.monthlyFee, flag(m.monthly, 25));
      const uptake = Math.max(0, Math.min(1, num(a.uptake, flag(m.uptake, 0.15))));
      const baseCustomers = customers || flag('simBaselineVolume', 100);

      let baseMargin = null;
      if (world()) { const s = await world().signal('gross_margin', now); if (s && s.value != null && (s.status === 'fresh' || s.status === 'degraded')) baseMargin = s.value; }
      const margin = baseMargin == null ? flag('simBaselineMargin', 0.45) : baseMargin;

      const members = Math.round(baseCustomers * uptake);
      const projectedAnnualRevenue = Math.round(members * monthlyFee * 12);
      const projectedAnnualMargin = Math.round(projectedAnnualRevenue * margin);

      // Integrate with the Simulation Council for demand/price sensitivity.
      let simRunId = null, simOutcome = null;
      try {
        if (runner()) {
          const wmSnap = world() ? await world().snapshot({ now: now }) : null;
          const res = await runner().run({ kind: m.scenario.kind, params: m.scenario.params, seed: o.seed == null ? ('bizmodel:' + model) : o.seed, n: o.n || 300, worldModel: wmSnap });
          if (res.ok) { simRunId = res.runId; simOutcome = res.outcomes.expected; }
        }
      } catch (_) {}

      return {
        ok: true, model: model,
        projection: { members: members, monthlyFee: monthlyFee, uptake: uptake, projectedAnnualRevenue: projectedAnnualRevenue, projectedAnnualMargin: projectedAnnualMargin, marginUsed: margin, marginStatus: baseMargin == null ? 'assumed' : 'derived' },
        simulation: { runId: simRunId, expected: simOutcome },
        assumptions: ['uptake ' + Math.round(uptake * 100) + '% of ' + baseCustomers + ' customers', 'monthly fee $' + monthlyFee, 'margin ' + Math.round(margin * 100) + '% (' + (baseMargin == null ? 'assumed' : 'from world model') + ')', 'demand/price sensitivity via Simulation Council (' + m.scenario.kind + ')'],
        confidence: customers ? 0.5 : 0.2
      };
    }
  };

  global.AAA_BUSINESS_MODEL_SIMULATOR = Sim;
})(typeof window !== 'undefined' ? window : this);
