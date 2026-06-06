/* Provenance Graph — append-only store + builder traces a recommendation to origin. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('provenance');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/prediction-closure.js');
  load('js/intelligence/calibration-registry.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/provenance-builder.js');
  const STORE = G.AAA_PROVENANCE;
  const B = G.AAA_PROVENANCE_BUILDER;

  // --- store: append-only snapshot, retrievable by subject ---
  const rec1 = await STORE.record({ subjectType: 'pricing_recommendation', subjectId: 'rec_x', subjectLabel: 'A' });
  t.ok('record returns an id + workspace + timestamp', !!rec1.id && rec1.workspaceId === 'ws_test' && !!rec1.createdAt);
  const rec2 = await STORE.record({ subjectType: 'pricing_recommendation', subjectId: 'rec_x', subjectLabel: 'A again' });
  t.ok('append-only: a second trace is a NEW document', rec2.id !== rec1.id);
  const forSubj = await STORE.forSubject('pricing_recommendation', 'rec_x');
  t.ok('forSubject returns every trace for the subject', forSubj.length === 2);
  t.eq('latestFor returns the newest', (await STORE.latestFor('pricing_recommendation', 'rec_x')).id, forSubj[0].id);
  t.eq('get round-trips', (await STORE.get(rec1.id)).subjectLabel, 'A');
  t.eq('forSubject is empty for an unknown subject', (await STORE.forSubject('estimate', 'nope')).length, 0);

  // --- builder: pricing recommendation gathers quotes, prediction, closure, calibration ---
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 22, resolvedAt: '2026-01-02T00:00:00Z' });
  await data.put('quotes', 'q2', { id: 'q2', quoteId: 'q2', workspaceId: 'ws_test', customerName: 'Bob', customerTotal: 600, status: 'lost', marginPct: 10, resolvedAt: '2026-01-03T00:00:00Z' });
  await data.put('agent_decisions', 'pred1', { id: 'pred1', kind: 'pricing_prediction', agent: 'pricing_optimizer', recommendationId: 'rec_pb', confidence: 70, workspaceId: 'ws_test' });
  await data.put('learning_feedback', 'lf1', { id: 'lf1', kind: 'closure', agent: 'pricing_optimizer', recommendationId: 'rec_pb', predictionId: 'pred1', status: 'validated', explanation: 'moved as recommended', workspaceId: 'ws_test' });
  // an active calibration version for the optimizer
  await data.put('calibration_versions', 'calv1', { id: 'calv1', agent: 'pricing_optimizer', version: 3, confidenceBias: 5, riskBias: -2, active: true, workspaceId: 'ws_test' });

  const rec = {
    id: 'rec_pb', type: 'price_band_losses', title: 'Low win rate in the $500-1k band',
    reasoning: 'Only 30% closed.', confidence: 60, adjustedConfidence: 65, risk: 35,
    supportingQuoteIds: ['q1', 'q2'], predictionId: 'pred1', expectedKpiImpact: 'Lift close rate',
    recommendedAction: 'Review pricing', supervisorReview: { verdict: 'approve', note: 'reasonable', riskFlags: [] }
  };
  const g = await B.build('pricing_recommendation', rec);
  t.eq('subject id + type captured', g.subjectId, 'rec_pb');
  t.eq('owning agent inferred', g.agent, 'pricing_optimizer');
  t.eq('deterministic model version', g.modelVersion, 'deterministic');
  t.eq('no prompt version for a deterministic agent', g.promptVersion, null);
  t.ok('source quotes fetched as snapshots', g.sourceQuotes.length === 2 && g.sourceQuotes.some((q) => q.customerName === 'Jane'));
  t.ok('resolved outcomes derived from quotes', g.outcomeIds.length === 2);
  t.ok('prediction id captured', g.predictionIds.indexOf('pred1') !== -1);
  t.ok('closure id captured', g.closureIds.indexOf('lf1') !== -1);
  t.ok('active calibration version recorded', g.calibrationVersion && g.calibrationVersion.version === 3 && g.calibrationVersion.confidenceBias === 5);
  t.ok('evidence carries reasoning + supervisor + closure', g.evidence.some((e) => e.kind === 'reasoning') && g.evidence.some((e) => e.kind === 'supervisor') && g.evidence.some((e) => e.kind === 'closure'));
  t.ok('node chain spans subject→model→calibration→evidence→quote→prediction→closure', ['subject', 'model', 'calibration', 'evidence', 'quote', 'prediction', 'closure'].every((tp) => g.nodes.some((n) => n.type === tp)));

  // --- builder: council session ---
  const session = { id: 'cs1', quoteId: 'q1', customerName: 'Jane', decision: 'revise', decisionConfidence: 72, disagreement: 40, predictionId: 'dec1', positions: [{ id: 'risk', title: 'Risk', stance: 'reject', confidence: 80, concern: 'high job risk' }, { id: 'finance', title: 'Finance', stance: 'abstain', confidence: 0 }] };
  const gc = await B.build('council_session', session);
  t.eq('council subject id', gc.subjectId, 'cs1');
  t.eq('council agent', gc.agent, 'agent_council');
  t.ok('council pulls its source quote', gc.sourceQuotes.length === 1 && gc.quoteIds[0] === 'q1');
  t.ok('council prediction id captured', gc.predictionIds.indexOf('dec1') !== -1);
  t.ok('voting seats become evidence; abstainers excluded', gc.evidence.some((e) => e.kind === 'vote' && /Risk/.test(e.label)) && !gc.evidence.some((e) => /Finance/.test(e.label)));

  // --- builder: closure subject ---
  const gcl = await B.build('prediction_closure', { id: 'lf1', predictionId: 'pred1', recommendationId: 'rec_pb', type: 'price_band_losses', segmentKey: '$500-1k', baseline: 0.3, observed: 0.45, status: 'validated', score: 1, explanation: 'moved as recommended', agent: 'pricing_optimizer' });
  t.eq('closure subject id', gcl.subjectId, 'lf1');
  t.ok('closure captures prediction + closure ids', gcl.predictionIds[0] === 'pred1' && gcl.closureIds[0] === 'lf1');
  t.ok('closure evidence explains the verdict', gcl.evidence.some((e) => /moved as recommended/.test(e.detail)));

  // --- builder: estimate subject ---
  const ge = await B.build('estimate', { id: 'q1', quoteId: 'q1', customerName: 'Jane', status: 'won', confidence: 80, risk: 20 });
  t.eq('estimate agent', ge.agent, 'estimator');
  t.ok('estimate uses itself as the source quote', ge.sourceQuotes.length === 1 && ge.quoteIds[0] === 'q1');

  // --- buildAndRecord persists an immutable trace, mutating no quote ---
  const beforeQuotes = JSON.stringify(data._store.quotes);
  const out = await B.buildAndRecord('pricing_recommendation', rec);
  t.ok('buildAndRecord stores the trace', out.ok === true && !!out.record.id && (await STORE.get(out.record.id)) !== null);
  t.eq('tracing mutates no quote/price', JSON.stringify(data._store.quotes), beforeQuotes);
  t.eq('recorded trace is retrievable by subject', (await STORE.latestFor('pricing_recommendation', 'rec_pb')).id, out.record.id);

  // --- P3 wiring: governed prompt/model versions flow into the trace ---
  // With no governed versions active, the trace stays deterministic (above).
  // Activate a governed prompt + model for the optimizer and re-trace.
  load('js/intelligence/governance-registry.js');
  const GOV = G.AAA_GOVERNANCE;
  G.AAA_RBAC.setRole('owner');
  const pv = await GOV.createDraft('prompt', 'pricing_optimizer', 'Optimizer system prompt v1', { actor: 'owner' });
  await GOV.propose(pv.version.id, { actor: 'owner' }); await GOV.approve(pv.version.id, { actor: 'owner' }); await GOV.activate(pv.version.id, { actor: 'owner' });
  const mv = await GOV.createDraft('model', 'pricing_optimizer', 'claude-opus-4-8', { actor: 'owner' });
  await GOV.propose(mv.version.id, { actor: 'owner' }); await GOV.approve(mv.version.id, { actor: 'owner' }); await GOV.activate(mv.version.id, { actor: 'owner' });
  const gGoverned = await B.build('pricing_recommendation', rec);
  t.eq('governed prompt version flows into the trace', gGoverned.promptVersion, 1);
  t.eq('governed prompt version id captured', gGoverned.promptVersionId, pv.version.id);
  t.eq('governed model version replaces "deterministic"', gGoverned.modelVersion, 'claude-opus-4-8');
  t.eq('governed model version id captured', gGoverned.modelVersionId, mv.version.id);
  t.ok('node chain now includes a prompt node', gGoverned.nodes.some((n) => n.type === 'prompt' && /governed/.test(n.label)));

  // --- null-tolerance: a missing quote store degrades to empty, never throws ---
  G.AAA_QUOTES = null;
  const gNull = await B.build('pricing_recommendation', { id: 'rec_z', supportingQuoteIds: ['q9'], reasoning: 'x' });
  t.ok('missing quotes degrades to empty sources', gNull.sourceQuotes.length === 0 && gNull.outcomeIds.length === 0);

  return t.report();
};
