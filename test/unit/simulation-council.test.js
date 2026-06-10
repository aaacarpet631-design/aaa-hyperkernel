/* Simulation Council (Counterfactual Engine) — immutable scenarios, read-only
 * isolation from production, deterministic replay, Monte Carlo bounds, policy
 * simulation, recommendation governance, and prediction-vs-actual learning. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  load('js/governance/audit-ledger.js');
  load('js/simulation/simulation-ledger.js');
  load('js/simulation/scenario-engine.js');
  load('js/simulation/outcome-estimator.js');
  load('js/simulation/monte-carlo-engine.js');
  load('js/simulation/strategy-scorecard.js');
  load('js/simulation/simulation-governance.js');
  load('js/simulation/counterfactual-runner.js');
  load('js/simulation/policy-simulator.js');
}

async function seedReality(data) {
  // A small real book of business so baselines are derived, not assumed.
  const q = (id, status, total, zip) => data.put('quotes', id, { id: id, status: status, total: total, zip: zip, margin: 0.45 });
  await q('q1', 'won', 1000, '77001'); await q('q2', 'won', 1400, '77002'); await q('q3', 'won', 1200, '77001');
  await q('q4', 'lost', 1300, '77002'); await q('q5', 'lost', 900, '77003'); await q('q6', 'won', 1600, '77002');
  await data.put('jobs', 'j1', { id: 'j1' });
}

module.exports = async function run() {
  const t = makeRunner('simulation-council');
  const { G, data } = setupEnv();
  loadAll();
  await seedReality(data);
  const RUNNER = G.AAA_COUNTERFACTUAL_RUNNER, SCEN = G.AAA_SCENARIO_ENGINE, EST = G.AAA_OUTCOME_ESTIMATOR;
  const MC = G.AAA_MONTE_CARLO, LEDGER = G.AAA_SIM_LEDGER, GOV = G.AAA_SIM_GOVERNANCE;
  const POLICY = G.AAA_POLICY_SIMULATOR, CARD = G.AAA_STRATEGY_SCORECARD;

  // ===== scenarios cover the directive's questions =====
  t.ok('six scenario kinds available', ['price_change', 'add_crew', 'drop_zip', 'fuel_change', 'ad_spend_change', 'disaster'].every((k) => SCEN.KINDS.indexOf(k) !== -1));
  const built = SCEN.build('price_change', { pct: 0.07 });
  t.ok('a scenario carries explicit assumptions (not a black box)', built.ok && built.scenario.assumptions.length >= 2);
  t.eq('unknown scenario is rejected', SCEN.build('teleport', {}).error, 'UNKNOWN_SCENARIO');

  // ===== baseline derived from real data, assumptions labeled =====
  const snap = await RUNNER.snapshot();
  const base = SCEN.baseline(snap);
  t.ok('baseline revenue derived from won quotes', base.revenue === 1000 + 1400 + 1200 + 1600);
  t.ok('baseline close rate derived from won/lost', Math.abs(base.closeRate - 4 / 6) < 1e-9);
  t.ok('assumed operational metrics are labeled honestly', base.assumed.indexOf('utilization') !== -1 && base.assumed.indexOf('csat') !== -1);

  // ===== production isolation: simulation never mutates production =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes, jobs: data._store.jobs, outcomes: data._store.outcomes || {} });
  const r1 = await RUNNER.run({ kind: 'price_change', params: { pct: 0.07 }, seed: 'sim-A', n: 500 });
  const prodAfter = JSON.stringify({ quotes: data._store.quotes, jobs: data._store.jobs, outcomes: data._store.outcomes || {} });
  t.eq('production collections are byte-for-byte unchanged after a simulation', prodAfter, prodBefore);
  t.ok('only the simulation ledger was written', Object.keys(data._store).indexOf('sim_runs') !== -1 && (data._store.sim_runs && Object.keys(data._store.sim_runs).length === 1));

  // ===== immutable run record with all required fields =====
  const stored = await LEDGER.get(r1.runId);
  const REQ = ['assumptions', 'snapshot', 'calibrationVersion', 'policyVersion', 'seed', 'outcomes'];
  t.ok('run records assumptions, snapshot, calibration+policy versions, seed, outcomes', REQ.every((f) => stored[f] !== undefined && stored[f] !== null));
  t.ok('snapshot captured the input graph hash', !!stored.snapshot.hash && stored.snapshot.counts.quotes === 6);

  // ===== deterministic replay =====
  const replay = await RUNNER.replay(r1.runId);
  t.ok('replaying a run reproduces identical outcomes (deterministic)', replay.ok === true && replay.matches === true);
  const again = MC.run(base, built.scenario, { seed: 'sim-A', n: 500 });
  const once = MC.run(base, built.scenario, { seed: 'sim-A', n: 500 });
  t.eq('the Monte Carlo engine is bit-identical for a fixed seed', JSON.stringify(again), JSON.stringify(once));
  const diff = MC.run(base, built.scenario, { seed: 'different', n: 500 });
  t.ok('a different seed explores a different draw', JSON.stringify(diff.best) !== JSON.stringify(again.best));

  // ===== Monte Carlo bounds =====
  const mc = r1.outcomes;
  t.ok('worst ≤ expected ≤ best on the objective (revenue)', mc.worst.revenue <= mc.expected.revenue + 1e-6 && mc.expected.revenue <= mc.best.revenue + 1e-6);
  t.ok('confidence interval is ordered p05 ≤ p50 ≤ p95', mc.ci.objective.p05 <= mc.ci.objective.p50 && mc.ci.objective.p50 <= mc.ci.objective.p95);
  t.ok('best/expected/worst reported for every metric', EST.METRICS.every((m) => mc.best[m] !== undefined && mc.expected[m] !== undefined && mc.worst[m] !== undefined));
  t.ok('a 7% price rise lifts expected margin vs baseline', mc.expected.margin > base.margin);

  // ===== outcome estimation across all seven metrics =====
  const point = EST.estimate(base, built.scenario);
  t.ok('estimator outputs all seven enterprise metrics', EST.METRICS.every((m) => typeof point[m] === 'number'));
  t.ok('estimate is pure (same inputs → same output)', JSON.stringify(EST.estimate(base, built.scenario, point.draw)) === JSON.stringify(point));

  // ===== policy simulation (no production touch) =====
  const pol = await POLICY.simulate('pricing', [{ label: 'up5', pct: 0.05 }, { label: 'up10', pct: 0.10 }], { seed: 'polseed', n: 300 });
  t.ok('policy sim ranks variants incl. the status-quo hold', pol.ok && pol.ranked.length === 3 && pol.ranked.some((v) => v.label === 'hold'));
  t.ok('every policy family is supported', ['pricing', 'dispatch', 'scheduling', 'marketing', 'approval'].every((p) => POLICY.POLICIES.indexOf(p) !== -1));
  t.eq('unknown policy family is rejected', (await POLICY.simulate('vibes', [])).error, 'UNKNOWN_POLICY');

  // ===== scorecard =====
  t.ok('scorecard yields upside/risk/confidence/score', r1.scorecard && typeof r1.scorecard.upside === 'number' && typeof r1.scorecard.risk === 'number' && r1.scorecard.confidence >= 0 && r1.scorecard.confidence <= 1);

  // ===== recommendation governance: nothing reaches production silently =====
  const prop = await GOV.propose(r1.runId, { action: 'Raise prices 7%', rationale: 'Expected margin lift with bounded downside.' });
  t.ok('a simulation recommendation is pending governance', prop.ok && prop.recommendation.status === 'pending_governance');
  t.ok('simulation.recommendation_proposed event emitted before production', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'simulation.recommendation_proposed' && e.payload.runId === r1.runId));
  t.eq('approval requires a written reason', (await GOV.approve(prop.recommendation.id, { reason: 'ok' })).error, 'JUSTIFICATION_REQUIRED');
  const appr = await GOV.approve(prop.recommendation.id, { reason: 'Council reviewed the downside band and approved a 7% rise.' });
  t.ok('an authorized human approves it into production', appr.ok && appr.recommendation.status === 'approved');

  // ===== learning: reality grades the prediction =====
  const predicted = stored.outcomes.expected;
  const spotOn = {}; EST.METRICS.forEach((m) => { spotOn[m] = predicted[m]; });
  const perfect = await GOV.recordActual(r1.runId, spotOn);
  t.ok('a perfect prediction scores accuracy 1.0', perfect.ok && Math.abs(perfect.accuracy - 1) < 1e-9);
  const r2 = await RUNNER.run({ kind: 'price_change', params: { pct: 0.07 }, seed: 'sim-B', n: 300 });
  const off = {}; EST.METRICS.forEach((m) => { off[m] = (r2.outcomes.expected[m] || 0) * 1.5 + 1; });
  const wrong = await GOV.recordActual(r2.runId, off);
  t.ok('a poor prediction scores lower accuracy', wrong.accuracy < perfect.accuracy);
  t.ok('prediction-vs-actual is computed per metric', wrong.errors.revenue && typeof wrong.errors.revenue.absPctError === 'number');
  t.ok('actuals are immutable appends (one per recordActual)', (await LEDGER.actuals(r1.runId)).length === 1);
  t.ok('calibration bias is updated from the delta', !!(await GOV.calibration('price_change')));
  t.ok('simulation.actual_recorded event emitted (learning signal)', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'simulation.actual_recorded'));

  // ===== dashboard read model =====
  const dash = await CARD.dashboard({ limit: 5 });
  t.ok('dashboard exposes all required sections', ['highestUpside', 'highestRisk', 'strongestConfidence', 'failedAssumptions', 'accuracyOverTime'].every((k) => dash[k] !== undefined));
  t.ok('accuracy over time has points once reality was recorded', dash.accuracyOverTime.length >= 2 && dash.overallAccuracy != null);
  t.ok('totals count simulations + reality checks', dash.totals.simulations >= 2 && dash.totals.evaluatedAgainstReality >= 2);

  return t.report();
};
