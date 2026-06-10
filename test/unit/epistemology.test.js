/* Enterprise Brain + Scientist — Belief Registry (Facts/Beliefs/Predictions/
 * Theories with enforced basis), Scientific Discovery Council (hypothesis →
 * experiment → evidence → theory), and the Knowledge Compounding Engine. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/world-model.js',
   'js/intelligence/causal-learning-engine.js', 'js/intelligence/causal-hypothesis-store.js',
   'js/innovation/experiment-registry.js',
   'js/epistemology/belief-registry.js', 'js/epistemology/scientific-discovery-council.js', 'js/epistemology/knowledge-compounding-engine.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

module.exports = async function run() {
  const t = makeRunner('epistemology');
  const { G, data } = setupEnv({ config: { theoryMinEvidence: 8 } });
  loadAll();
  const B = G.AAA_BELIEF_REGISTRY, SCI = G.AAA_SCIENTIFIC_DISCOVERY_COUNCIL, K = G.AAA_KNOWLEDGE_COMPOUNDING_ENGINE;

  // ===== the four claim types are distinguished, with enforced basis =====
  t.eq('a fact without an observation is rejected', (await B.assert('fact', { statement: 'margin is 50%' })).error, 'FACT_REQUIRES_OBSERVATION');
  const fact = await B.assert('fact', { statement: 'gross margin is 0.5', observation: { signal: 'gross_margin', value: 0.5 } });
  t.ok('a fact with an observation is recorded at confidence 1', fact.ok && fact.claim.type === 'fact' && fact.claim.confidence === 1 && fact.claim.status === 'observed');
  t.eq('a belief without a hypothesis is rejected', (await B.assert('belief', { statement: 'speed wins' })).error, 'BELIEF_REQUIRES_HYPOTHESIS');
  const belief = await B.assert('belief', { statement: 'faster response increases close rate', cause: 'response_time', effect: 'close_rate', hypothesisId: 'h0', confidence: 0.5 });
  t.ok('a belief is a claim (<1 confidence, proposed)', belief.ok && belief.claim.confidence < 1 && belief.claim.status === 'proposed');
  t.eq('a prediction needs an expected value + target time', (await B.assert('prediction', { statement: 'margin will rise' })).error, 'PREDICTION_REQUIRES_EXPECTED_AND_TARGET');
  const pred = await B.assert('prediction', { statement: 'close rate hits 0.6 next month', expected: 0.6, targetAt: iso(NOW + 30 * 86400000), subject: 'close_rate' });
  t.ok('a prediction is recorded forward', pred.ok && pred.claim.type === 'prediction');
  t.eq('a theory cannot be asserted directly (only promoted)', (await B.assert('theory', { statement: 'x' })).error, 'THEORY_IS_PROMOTED_NOT_ASSERTED');

  // ===== append-only history; beliefs cannot be silently relabeled =====
  t.ok('claim has an append-only event trail', (await B.history(belief.claim.id)).length >= 1);

  // ===== prediction resolves against reality =====
  const resolved = await B.resolvePrediction(pred.claim.id, 0.57);
  t.ok('a prediction resolves with an accuracy score', resolved.ok && resolved.accuracy > 0.9 && (await B.get(pred.claim.id)).status === 'resolved');

  // ===== Scientific Discovery loop: bottleneck → hypothesis → experiment → evidence → theory =====
  await data.put('world_signals', 's1', { signalId: 's1', signalType: 'close_rate', value: 0.3, confidence: 0.9, volatility: 0.08, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
  const bn = await SCI.identifyBottleneck(NOW);
  t.ok('the council identifies a real bottleneck from signals', bn.status === 'derived' && bn.bottlenecks.some((b) => b.signal === 'close_rate'));
  t.eq('with no usable signals it asks no questions (honest)', (await SCI.identifyBottleneck(NOW + 400 * 3600000)).status, 'insufficient_data');

  const hyp = await SCI.formHypothesis('response_time', 'close_rate', 'Faster first response raises close rate', { statement: 'Faster response raises close rate' });
  t.ok('forming a hypothesis creates a causal link AND a belief', hyp.ok && !!hyp.hypothesisId && hyp.belief.type === 'belief');
  const exp = await SCI.designExperiment(hyp.belief.id, {});
  t.ok('a governed experiment is designed (rollback required, present)', exp.ok && exp.experiment.governanceRequired === true && !!exp.experiment.rollbackPlan);

  // accumulate supporting evidence → belief becomes supported, then a theory
  let status;
  for (let i = 0; i < 10; i++) status = (await SCI.recordEvidence(hyp.belief.id, true)).status;
  t.eq('accumulated evidence makes the belief supported', status, 'supported');
  const promoted = await SCI.concludeAndCompound(hyp.belief.id);
  t.ok('a sufficiently-supported belief is promoted to a theory', promoted.ok && promoted.theory.type === 'theory' && promoted.theory.status === 'established');
  t.eq('the original belief is marked promoted (append-only)', (await B.get(hyp.belief.id)).status, 'promoted');

  // a thinly-supported belief cannot become a theory
  const weak = await SCI.formHypothesis('marketing_cac', 'close_rate', 'CAC affects close rate');
  await SCI.recordEvidence(weak.belief.id, true);
  t.eq('a belief without enough evidence is not promotable', (await B.promoteToTheory(weak.belief.id)).error, 'BELIEF_NOT_SUPPORTED');

  // ===== research agenda =====
  const agenda = await SCI.researchAgenda(NOW);
  t.ok('the weekly research agenda surfaces ranked questions', agenda.questions.length >= 1 && !!agenda.questions[0].question);

  // ===== knowledge compounding =====
  const know = await K.assess();
  t.ok('knowledge engine counts facts/beliefs/predictions/theories', know.counts.fact >= 1 && know.counts.theory >= 1 && know.counts.prediction >= 1);
  t.ok('the moat is compounding once a theory exists', know.moatScore != null && know.moatStatus === 'compounding');
  t.ok('prediction accuracy reflects resolved predictions', know.predictionAccuracy != null);
  const snap = await K.snapshot();
  t.ok('a knowledge snapshot is persisted for the compounding curve', !!snap.id && (await K.trajectory()).length === 1);

  // ===== production isolation: epistemology writes only its own collections =====
  t.ok('no production business collections were created', data._store.quotes === undefined && data._store.jobs === undefined);

  return t.report();
};
