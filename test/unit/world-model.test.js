/* World Model + Signal Intelligence — append-only signal ledger, freshness
 * sentinel (block/degrade/insufficient), honest derivation, causal hypotheses,
 * prediction-vs-actual, intelligence scorecard, production isolation, and safe
 * integration with the Simulation Council snapshot input. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadWorldModel() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js',
   'js/intelligence/signal-derivation-engine.js', 'js/intelligence/world-model.js', 'js/intelligence/signal-quality-scorecard.js',
   'js/intelligence/causal-learning-engine.js', 'js/intelligence/causal-hypothesis-store.js',
   'js/intelligence/prediction-actual-comparator.js', 'js/intelligence/intelligence-scorecard.js',
   // Simulation Council (for the integration test)
   'js/simulation/simulation-ledger.js', 'js/simulation/scenario-engine.js', 'js/simulation/outcome-estimator.js',
   'js/simulation/monte-carlo-engine.js', 'js/simulation/strategy-scorecard.js', 'js/simulation/simulation-governance.js',
   'js/simulation/counterfactual-runner.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

module.exports = async function run() {
  const t = makeRunner('world-model');
  const { G, data } = setupEnv();
  loadWorldModel();
  const LEDGER = G.AAA_WORLD_STATE_LEDGER, WM = G.AAA_WORLD_MODEL, DERIVE = G.AAA_SIGNAL_DERIVATION_ENGINE;
  const QUALITY = G.AAA_SIGNAL_QUALITY_SCORECARD, CAUSAL = G.AAA_CAUSAL_HYPOTHESIS_STORE, LEARN = G.AAA_CAUSAL_LEARNING_ENGINE;
  const CMP = G.AAA_PREDICTION_COMPARATOR, ISCORE = G.AAA_INTELLIGENCE_SCORECARD, RUNNER = G.AAA_COUNTERFACTUAL_RUNNER;

  // ===== scorecard: insufficient data, no flattering defaults (empty world) =====
  const empty = await ISCORE.evaluate(NOW);
  t.eq('intelligence scorecard reports insufficient_data when empty', empty.status, 'insufficient_data');
  t.eq('…and does not invent a score', empty.score, null);
  t.eq('…no flattering default for prediction accuracy', empty.components.predictionAccuracy.status, 'insufficient_data');

  // ===== signal creation + registry governance =====
  const ok = await LEDGER.append({ signalType: 'gross_margin', value: 0.5, source: 'test', confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 3600000) });
  t.ok('a registered signal is created with an id', ok.ok === true && !!ok.signalId);
  t.ok('signal carries the full schema', ['signalId', 'signalType', 'value', 'unit', 'source', 'confidence', 'volatility', 'observedAt', 'expiresAt', 'stalePolicy', 'derivationMethod', 'relatedEntities', 'provenanceId'].every((f) => ok.record[f] !== undefined));
  t.eq('an unregistered signal type is rejected (governance)', (await LEDGER.append({ signalType: 'vibes', value: 1 })).error, 'UNREGISTERED_SIGNAL_TYPE');

  // ===== append-only ledger (immutable history) =====
  const before = (await LEDGER.getRawLedger()).length;
  await LEDGER.append({ signalType: 'gross_margin', value: 0.55, source: 'test', confidence: 0.9, observedAt: iso(NOW + 1000), expiresAt: iso(NOW + 3600000) });
  t.eq('appending adds a new record (never overwrites)', (await LEDGER.getRawLedger()).length, before + 1);
  t.ok('records are deep-frozen', Object.isFrozen(ok.record));
  const keep = ok.record.value; try { ok.record.value = 9.9; } catch (_) {}
  t.eq('a frozen record cannot be mutated', ok.record.value, keep);

  // ===== current-state read model derived from the timeline =====
  const rm = await LEDGER.deriveCurrentReadModel(NOW + 2000);
  t.ok('read model projects the latest record per type', rm.gross_margin.value === 0.55 && rm.gross_margin.status === 'fresh');

  // ===== stale signal: degrade then collapse to insufficient_data =====
  await LEDGER.append({ signalType: 'response_time', value: 24, source: 'test', confidence: 0.9, volatility: 0.8, observedAt: iso(NOW - 100000), expiresAt: iso(NOW - 50000), stalePolicy: 'degrade_confidence' });
  const degraded = (await LEDGER.deriveCurrentReadModel(NOW)).response_time;
  t.ok('a stale signal is degraded with reduced confidence', degraded.status === 'degraded' && degraded.confidence < 0.9);
  const collapsed = (await LEDGER.deriveCurrentReadModel(NOW + 50 * 3600000)).response_time;
  t.eq('a very stale signal collapses to insufficient_data', collapsed.status, 'insufficient_data');

  // ===== stale signal: block policy withholds the value =====
  await LEDGER.append({ signalType: 'schedule_capacity', value: 12, source: 'test', confidence: 0.9, observedAt: iso(NOW - 10000), expiresAt: iso(NOW - 5000), stalePolicy: 'block' });
  const blocked = (await LEDGER.deriveCurrentReadModel(NOW)).schedule_capacity;
  t.ok('a stale block-policy signal is blocked (value withheld)', blocked.status === 'blocked' && blocked.value === null);

  // ===== honest derivation from real data =====
  await data.put('leads', 'l1', { id: 'l1', createdAt: iso(NOW) });
  await data.put('leads', 'l2', { id: 'l2', createdAt: iso(NOW) });
  await data.put('leads', 'l3', { id: 'l3', createdAt: iso(NOW) });
  await data.put('quotes', 'q1', { id: 'q1', status: 'won', total: 1000, margin: 0.45 });
  await data.put('quotes', 'q2', { id: 'q2', status: 'won', total: 1200, margin: 0.5 });
  await data.put('quotes', 'q3', { id: 'q3', status: 'lost', total: 900, margin: 0.4 });
  const prodBefore = JSON.stringify({ leads: data._store.leads, quotes: data._store.quotes, jobs: data._store.jobs || {} });
  await DERIVE.deriveAll({ now: NOW + 5000, windowMs: 604800000 });
  const derived = await LEDGER.deriveCurrentReadModel(NOW + 6000);
  t.eq('derived lead volume counts real leads', derived.lead_volume.value, 3);
  t.ok('derived close rate = won/(won+lost)', Math.abs(derived.close_rate.value - 2 / 3) < 1e-9);
  t.ok('derived gross margin from quote margins', Math.abs(derived.gross_margin.value - 0.45) < 1e-9);
  t.eq('a signal with no data source is insufficient_data, not fabricated', derived.crew_utilization.status, 'insufficient_data');

  // ===== no production mutation =====
  const prodAfter = JSON.stringify({ leads: data._store.leads, quotes: data._store.quotes, jobs: data._store.jobs || {} });
  t.eq('derivation does not mutate production collections', prodAfter, prodBefore);

  // ===== causal layer =====
  const hyp = await CAUSAL.create('lead_volume', 'gross_margin', 'More volume lets us filter for higher-margin jobs');
  t.eq('a new hypothesis starts proposed', hyp.status, 'proposed');
  await CAUSAL.appendEvidence(hyp.hypothesisId, true);
  t.ok('evidence is appended (immutable)', (await CAUSAL.evidence(hyp.hypothesisId)).length === 1);
  for (let i = 0; i < 9; i++) await CAUSAL.appendEvidence(hyp.hypothesisId, true);
  t.eq('accumulated supporting evidence → supported', (await CAUSAL.get(hyp.hypothesisId)).status, 'supported');
  const bad = await CAUSAL.create('marketing_cac', 'close_rate', 'Spending more lowers close rate');
  for (let i = 0; i < 8; i++) await CAUSAL.appendEvidence(bad.hypothesisId, false);
  t.eq('counter-evidence → rejected', (await CAUSAL.get(bad.hypothesisId)).status, 'rejected');
  t.eq('correlation is never auto-promoted past proposed', (await LEARN.suggestFromLedger('lead_volume', 'gross_margin')).status, 'proposed');

  // ===== prediction vs actual scoring =====
  const perfect = await CMP.logComparison('sim_1', 'gross_margin', 0.5, 0.5);
  t.ok('a perfect prediction scores accuracy 1.0', perfect && Math.abs(perfect.accuracy - 1) < 1e-9);
  await CMP.logComparison('sim_1', 'close_rate', 0.5, 0.45); // 10% variance → 0.9
  t.ok('average accuracy aggregates deltas', Math.abs((await CMP.getAverageAccuracy()) - 0.95) < 1e-9);
  t.eq('null predicted/actual is skipped (no fabricated accuracy)', await CMP.logComparison('s', 'x', null, 5), null);

  // ===== signal quality + intelligence scorecard now have data =====
  const quality = await QUALITY.score(NOW + 1000);
  t.ok('signal quality reports coverage/freshness/confidence', quality.status === 'operational' && quality.coverage > 0 && quality.avgConfidence > 0);
  const score = await ISCORE.evaluate(NOW + 1000);
  t.ok('intelligence scorecard is operational with real components', score.status === 'operational' && typeof score.score === 'number');
  t.eq('business impact stays honest (insufficient_data)', score.components.businessImpact.status, 'insufficient_data');
  t.eq('causal maturity is now scored (supported hypothesis exists)', score.components.causalMaturity.status, 'ok');

  // ===== integration: Simulation Council consumes a world-model snapshot safely =====
  // Make a fresh close_rate + gross_margin (usable) and a stale-blocked crew_utilization (withheld).
  await LEDGER.append({ signalType: 'crew_utilization', value: 0.95, source: 'test', confidence: 0.9, observedAt: iso(NOW + 9000), expiresAt: iso(NOW + 9500), stalePolicy: 'block' });
  const snapshot = await WM.snapshot({ now: NOW + 10000, minConfidence: 0.2 });
  t.ok('snapshot separates usable from withheld signals', !!snapshot.usable.close_rate && !!snapshot.withheld.crew_utilization);
  t.ok('snapshot is frozen (read-only)', Object.isFrozen(snapshot));

  const simProdBefore = JSON.stringify({ quotes: data._store.quotes, leads: data._store.leads });
  const sim = await RUNNER.run({ kind: 'price_change', params: { pct: 0.07 }, seed: 'wm', n: 200, worldModel: snapshot });
  const applied = (sim.baseline.signalsApplied || []).map((s) => s.signal);
  t.ok('simulation applies usable world-model signals to its baseline', applied.indexOf('close_rate') !== -1 && applied.indexOf('gross_margin') !== -1);
  t.ok('a withheld stale signal is NOT applied (no silent stale usage)', applied.indexOf('crew_utilization') === -1);
  t.eq('baseline close rate came from the world model', sim.baseline.closeRate, snapshot.usable.close_rate.value);
  t.eq('consuming a snapshot does not mutate production', JSON.stringify({ quotes: data._store.quotes, leads: data._store.leads }), simProdBefore);

  return t.report();
};
