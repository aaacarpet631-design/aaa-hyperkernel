/* Prediction closure — scoring, append-only, no-mutation, calibration, audit, owner-only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const T0 = '2026-06-01T00:00:00Z';
const BEFORE = '2026-05-01T00:00:00Z';
const AFTER = '2026-06-10T00:00:00Z';

module.exports = async function run() {
  const t = makeRunner('prediction-closure');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js');
  load('js/intelligence/prediction-closure.js');
  const C = G.AAA_PREDICTION_CLOSURE;
  const O = G.AAA_PRICING_OPTIMIZER;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  let qn = 0;
  function q(f) { qn++; const id = 'q' + qn; return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', serviceType: ['carpet_install'], zip: '77002', leadSource: 'google', customerTotal: 1500, marginPct: 30, risk: 20, finalPrice: f.status === 'won' ? 1500 : null, resolvedAt: AFTER }, f)); }
  function pred(f) { return data.put('agent_decisions', f.id, Object.assign({ kind: 'pricing_prediction', agent: 'pricing_optimizer', workspaceId: 'ws_test', metric: 'winRate', createdAt: T0, confidence: 50 }, f)); }

  // Pre-prediction quotes (must be EXCLUDED from observed).
  await q({ leadSource: 'google', status: 'won', resolvedAt: BEFORE });
  await q({ leadSource: 'google', status: 'lost', resolvedAt: BEFORE });

  // VALIDATED: google was weak (baseline 0), now wins after the call.
  await q({ leadSource: 'google', status: 'won', resolvedAt: AFTER });
  await q({ leadSource: 'google', status: 'won', resolvedAt: AFTER });
  await q({ leadSource: 'google', status: 'won', resolvedAt: AFTER });
  await q({ leadSource: 'google', status: 'lost', resolvedAt: AFTER });
  await pred({ id: 'P1', recommendationType: 'weak_lead_source', segment: 'google', segmentDim: 'leadSource', expectedDirection: 'up', baseline: 0, baselineSample: 3 });

  // CONTRADICTED: 77002 was strong (baseline 1.0), now mostly loses.
  await q({ zip: '77002', leadSource: 'referral', status: 'won', resolvedAt: AFTER });
  await q({ zip: '77002', leadSource: 'referral', status: 'lost', resolvedAt: AFTER });
  await q({ zip: '77002', leadSource: 'referral', status: 'lost', resolvedAt: AFTER });
  await q({ zip: '77002', leadSource: 'referral', status: 'lost', resolvedAt: AFTER });
  await pred({ id: 'P2', recommendationType: 'strong_segment', segment: '77002', segmentDim: 'zip', expectedDirection: 'maintain_high', baseline: 1.0, baselineSample: 4 });

  // INCONCLUSIVE: small observed sample.
  await q({ leadSource: 'yelp', status: 'won', resolvedAt: AFTER });
  await pred({ id: 'P3', recommendationType: 'weak_lead_source', segment: 'yelp', segmentDim: 'leadSource', expectedDirection: 'up', baseline: 0.2, baselineSample: 5 });

  // Malformed prediction + malformed quote must not throw.
  await pred({ id: 'P4', recommendationType: 'price_band_losses', segment: 'unknown', segmentDim: 'priceBand', expectedDirection: 'up', baseline: null });
  await data.put('quotes', 'qbad', { id: 'qbad', quoteId: 'qbad', workspaceId: 'ws_test', status: 'won' });

  const beforeQuotes = JSON.stringify(data._store.quotes);
  const evals = await C.evaluate();
  const byId = {}; evals.forEach((e) => { byId[e.predictionId] = e; });

  t.ok('evaluated all predictions', evals.length === 4);
  t.eq('P1 validated', byId.P1.status, 'validated');
  t.ok('P1 calibration signal (confidence up, risk down)', byId.P1.confidenceDelta === 10 && byId.P1.riskDelta === -5 && byId.P1.score === 1);
  t.eq('P1 observed excludes pre-prediction quotes', byId.P1.observedSample, 4);
  t.eq('P2 contradicted', byId.P2.status, 'contradicted');
  t.ok('P2 calibration signal (confidence down)', byId.P2.confidenceDelta === -10 && byId.P2.score === -1);
  t.eq('P3 inconclusive (small sample)', byId.P3.status, 'inconclusive');
  t.ok('P3 explains the small sample', /enough new outcomes/i.test(byId.P3.explanation));
  t.ok('malformed prediction handled', byId.P4.status === 'inconclusive');

  // --- append-only persistence: only conclusive closures, idempotent ---
  const first = await C.close({ actor: 'owner' });
  t.eq('persists only conclusive closures', first.closed, 2);
  const again = await C.close({ actor: 'owner' });
  t.eq('close is idempotent (no duplicates)', again.closed, 0);
  t.eq('two closure records on file', (await C.closures()).length, 2);

  // --- no mutation of quotes/prices/margins ---
  t.eq('closure mutated no quotes', JSON.stringify(data._store.quotes), beforeQuotes);
  t.ok('no rate card written', !data._store.rate_cards && !data._store.rate_card);
  t.ok('engine exposes no price-mutation method', typeof C.changePrice === 'undefined' && typeof C.applyCalibration === 'undefined');

  // --- supervisor calibration signal (stored, advisory, not applied) ---
  const cal = await C.calibrationSummary();
  const opt = cal.agents.find((a) => a.agent === 'pricing_optimizer');
  t.ok('calibration summary present', opt && opt.validated === 1 && opt.contradicted === 1 && opt.validationRate === 0.5);
  t.ok('calibration is advisory, never auto-applied', opt.applied === false && typeof opt.suggestedConfidenceBias === 'number');

  // --- owner mark-reviewed is audited; AI + crew blocked ---
  RB.setRole('owner');
  const rev = await C.markReviewed('P1', { actor: 'owner', note: 'good call' });
  t.ok('owner mark-reviewed ok', rev.ok === true);
  t.ok('review audited (REVIEW_LEARNING allowed)', (await GW.recentAudit(100)).some((a) => a.action === 'REVIEW_LEARNING' && a.decision === 'allowed'));
  t.eq('AI cannot mark reviewed', (await C.markReviewed('P1', { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot mark reviewed (owner-only)', (await C.markReviewed('P1', { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');

  // --- optimizer.createPrediction captures a baseline (loop wiring) ---
  const a = await O.analyze();
  if (a.recommendations.length) {
    const made = await O.createPrediction(a.recommendations[0], { actor: 'owner' });
    const dec = await data.get('agent_decisions', made.predictionId);
    t.ok('new prediction captured a baseline + segment dim', dec && 'baseline' in dec && !!dec.segmentDim && !!dec.metric);
  } else { t.ok('new prediction captured a baseline + segment dim (no recs to test)', true); }

  return t.report();
};
