/* Innovation Council — opportunity discovery, business-model simulation via the
 * Simulation Council, technology scoring, automation discovery, experiment
 * governance (rollback required), recommendation governance, append-only
 * history, and production isolation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/signal-derivation-engine.js', 'js/intelligence/world-model.js',
   // Simulation Council (business model simulator integrates with it)
   'js/simulation/simulation-ledger.js', 'js/simulation/scenario-engine.js', 'js/simulation/outcome-estimator.js', 'js/simulation/monte-carlo-engine.js', 'js/simulation/strategy-scorecard.js', 'js/simulation/simulation-governance.js', 'js/simulation/counterfactual-runner.js',
   'js/revenue/council-governance.js', 'js/revenue/demand-pulse-engine.js', 'js/revenue/neighborhood-opportunity-engine.js', 'js/revenue/competitor-intelligence.js', 'js/revenue/market-intelligence.js',
   'js/innovation/adjacency-mapper.js', 'js/innovation/opportunity-registry.js', 'js/innovation/venture-discovery-engine.js', 'js/innovation/business-model-simulator.js',
   'js/innovation/technology-scout-engine.js', 'js/innovation/automation-discovery-engine.js', 'js/innovation/experiment-registry.js', 'js/innovation/experiment-scorecard.js',
   'js/innovation/innovation-council.js', 'js/innovation/innovation-dashboard.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

async function seed(data) {
  const q = (id, status, total, margin, ctx) => data.put('quotes', id, { id: id, status: status, total: total, margin: margin, context: ctx, serviceType: 'cleaning' });
  await q('q1', 'won', 1200, 0.5, 'residential'); await q('q2', 'won', 5000, 0.5, 'commercial office building'); await q('q3', 'lost', 900, 0.3, 'residential');
  for (let i = 0; i < 5; i++) await data.put('customers', 'c' + i, { id: 'c' + i, name: 'Cust' + i });
  await data.put('world_signals', 'ws1', { signalId: 'ws1', signalType: 'gross_margin', value: 0.5, confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
}

module.exports = async function run() {
  const t = makeRunner('innovation-council');
  const { G, data } = setupEnv();
  loadAll();
  await seed(data);
  const C = G.AAA_INNOVATION_COUNCIL, REG = G.AAA_OPPORTUNITY_REGISTRY, GOV = G.AAA_COUNCIL_GOVERNANCE, DASH = G.AAA_INNOVATION_DASHBOARD;

  // ===== opportunity discovery =====
  const disc = await C.discoverVentures({ now: NOW, limit: 3 });
  t.ok('venture discovery finds adjacent opportunities', disc.discovered.length >= 3 && disc.discovered[0].opportunity);
  t.ok('opportunities carry margin estimate + confidence + evidence', disc.discovered[0].expectedMargin !== undefined && disc.discovered[0].confidence != null && !!disc.discovered[0].evidence);
  t.ok('commercial-contracts opportunity has real demand evidence', disc.discovered.some((o) => o.opportunity === 'commercial_contracts' && o.evidence.demandEvidence >= 1));
  t.ok('top opportunities were registered (append-only)', disc.registered.length === 3 && (await REG.list()).length === 3);

  // ===== business model simulation (integrates Simulation Council) =====
  const sim = await C.simulateModel('maintenance_membership', { seed: 'bm', n: 200, assumptions: { monthlyFee: 30, uptake: 0.2 } });
  t.ok('business model projects recurring revenue from real customer count', sim.ok && sim.projection.projectedAnnualRevenue > 0);
  t.ok('business model simulation produced a Simulation Council run', !!sim.simulation.runId && (await G.AAA_SIM_LEDGER.get(sim.simulation.runId)) !== null);
  t.ok('assumptions are explicit', Array.isArray(sim.assumptions) && sim.assumptions.length >= 3);

  // ===== technology scoring =====
  const tech = await G.AAA_TECHNOLOGY_SCOUT_ENGINE.track({ technology: 'LIDAR room scanner', category: 'measurement_device', annualBenefit: 12000, implementationCost: 4000, annualCost: 500 });
  const scored = G.AAA_TECHNOLOGY_SCOUT_ENGINE.score(tech);
  t.ok('technology ROI scored from explicit inputs', scored.roiEstimate != null && scored.roiEstimate > 0 && /Adopt|Pilot/.test(scored.recommendation));
  t.eq('a technology with no cost basis is insufficient_data', G.AAA_TECHNOLOGY_SCOUT_ENGINE.score({ technology: 'mystery' }).status, 'insufficient_data');

  // ===== automation discovery =====
  const autos = C.discoverAutomation([
    { name: 'manual review request texting', timesPerWeek: 20, minutesEach: 5, risk: 0.1, complexity: 0.2, automationCost: 300 },
    { name: 'sign legal contracts', timesPerWeek: 2, minutesEach: 10, risk: 0.9, complexity: 0.8 }
  ]);
  t.ok('automation discovery ranks candidates by score', autos.length === 2 && autos[0].score >= autos[1].score);
  t.ok('a high-risk task is not recommended for auto-run', autos.find((a) => /legal/.test(a.task)).recommendation.indexOf('Do not auto-run') !== -1);

  // ===== experiment governance: rollback plan required =====
  const incomplete = await C.createExperiment({ hypothesis: 'Memberships lift LTV', assumptions: ['x'], expectedOutcome: '+10% LTV', successCriteria: '>5% uptake' });
  t.ok('an experiment without a rollback plan is REJECTED', incomplete.ok === false && incomplete.error === 'INCOMPLETE_EXPERIMENT' && incomplete.missing.indexOf('rollbackPlan') !== -1);
  const complete = await C.createExperiment({ hypothesis: 'Memberships lift LTV', assumptions: ['steady churn'], expectedOutcome: '+10% LTV', successCriteria: '>5% uptake in 60 days', governanceRequired: true, rollbackPlan: 'Cancel memberships, refund prorated, revert pricing page.' });
  t.ok('a fully-specified experiment is accepted', complete.ok === true && complete.experiment.status === 'proposed');
  t.ok('experiment carries the full required schema', ['experimentId', 'hypothesis', 'assumptions', 'expectedOutcome', 'successCriteria', 'governanceRequired', 'rollbackPlan'].every((k) => complete.experiment[k] !== undefined));

  // ===== recommendation governance + simulation integration =====
  const opp = (await REG.list())[0];
  const prodBefore = JSON.stringify({ quotes: data._store.quotes, customers: data._store.customers });
  const validated = await C.validateOpportunity(opp.id, 'maintenance_membership', { seed: 'v', n: 150 });
  t.ok('validating an opportunity proposes it into governance', validated.ok && validated.proposal.status === 'pending_governance');
  t.ok('innovation.recommendation_proposed event emitted', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'innovation.recommendation_proposed'));
  t.eq('the opportunity moved to simulating (append-only history)', (await REG.get(opp.id)).status, 'simulating');
  t.ok('opportunity status history is append-only', (await REG.history(opp.id)).length >= 2);
  const appr = await GOV.approve(validated.proposal.id, { reason: 'Reviewed membership projection + sim; approve a pilot cohort.' });
  t.ok('human approval emits policy.change_approved', appr.ok && (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'policy.change_approved'));

  // ===== production isolation =====
  t.eq('innovation flow does not mutate production', JSON.stringify({ quotes: data._store.quotes, customers: data._store.customers }), prodBefore);

  // ===== deterministic =====
  const d1 = await C.simulateModel('subscription', { seed: 'fixed', n: 100 });
  const d2 = await C.simulateModel('subscription', { seed: 'fixed', n: 100 });
  t.eq('business model projection is deterministic for fixed inputs', JSON.stringify(d1.projection), JSON.stringify(d2.projection));

  // ===== dashboard read model =====
  const dash = await DASH.view({ limit: 5 });
  t.ok('dashboard exposes required sections', ['opportunitiesDiscovered', 'topOpportunities', 'validated', 'rejected', 'projectedMargin', 'experiments'].every((k) => dash[k] !== undefined));
  t.ok('experiments portfolio is reported', dash.experiments.total >= 1);

  return t.report();
};
