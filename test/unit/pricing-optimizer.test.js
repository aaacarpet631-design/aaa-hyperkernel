/* Pricing Optimizer — recommendations, no auto price change, supervisor, prediction, audit, owner-only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const BASE = Date.parse('2026-05-01T00:00:00Z');
function iso(days) { return new Date(BASE + days * 86400000).toISOString(); }

module.exports = async function run() {
  const t = makeRunner('pricing-optimizer');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js');
  const O = G.AAA_PRICING_OPTIMIZER;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  let n = 0;
  function seed(q) {
    n++; const id = 'q' + n; const won = q.status === 'won';
    return data.put('quotes', id, Object.assign({
      quoteId: id, id: id, workspaceId: 'ws_test', serviceType: ['carpet_install'], zip: '77002', leadSource: 'referral',
      customerTotal: 1500, finalPrice: won ? 1500 : null, marginPct: 30, risk: 20, wonLostReason: won ? 'value' : 'price',
      sentAt: iso(0), resolvedAt: iso(won ? 1 : 5),
      statusHistory: [{ status: 'sent', at: iso(0) }, { status: q.status, at: iso(won ? 1 : 5) }]
    }, q));
  }
  for (let i = 0; i < 3; i++) await seed({ status: 'won' });
  await seed({ status: 'won', customerTotal: 1800, finalPrice: 1800, marginPct: 10 });   // low-margin win
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2600, risk: 40, wonLostReason: 'price too high' });
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2700, risk: 45, wonLostReason: 'price too high' });
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2800, risk: 40, wonLostReason: 'timing' });
  await seed({ status: 'won', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 900, finalPrice: 900, risk: 70 });
  await seed({ status: 'lost', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 950, risk: 75, wonLostReason: 'scope' });
  await seed({ status: 'lost', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 1000, risk: 70, wonLostReason: 'scope' });
  await data.put('quotes', 'qbad', { quoteId: 'qbad', id: 'qbad', workspaceId: 'ws_test', status: 'won' }); // malformed

  // --- SPEC contract ---
  t.ok('spec is recommendation-only', O.SPEC.blockedActions.indexOf('change_price') !== -1 && O.SPEC.blockedActions.indexOf('edit_rate_card') !== -1 && O.SPEC.humanApprovalThreshold);

  // Snapshot the books to prove analyze() mutates nothing.
  const beforeQuotes = JSON.stringify(data._store.quotes);
  const a = await O.analyze();
  t.ok('analyze ok + produced recommendations', a.ok === true && a.recommendations.length >= 4);
  t.ok('every recommendation requires human review', a.recommendations.every((r) => r.reviewRequired === true));
  t.ok('recommendations carry the full contract', a.recommendations.every((r) => r.title && r.reasoning && typeof r.confidence === 'number' && typeof r.risk === 'number' && Array.isArray(r.supportingQuoteIds) && r.recommendedAction && r.expectedKpiImpact));

  const types = a.recommendations.map((r) => r.type);
  t.ok('detects loss-heavy price band', types.indexOf('price_band_losses') !== -1);
  t.ok('detects low-margin wins', types.indexOf('low_margin_wins') !== -1);
  t.ok('detects a strong segment', types.indexOf('strong_segment') !== -1);
  t.ok('detects a weak lead source', types.indexOf('weak_lead_source') !== -1);
  t.ok('flags high-risk jobs', types.indexOf('high_risk_jobs') !== -1);

  // --- NO automatic price mutation ---
  t.eq('analyze() did not touch any quote/price', JSON.stringify(data._store.quotes), beforeQuotes);
  t.ok('no rate card was written', !data._store.rate_cards && !data._store.rate_card);
  t.ok('optimizer exposes no price-mutation method', typeof O.changePrice === 'undefined' && typeof O.applyPrice === 'undefined' && typeof O.setRateCard === 'undefined');

  // --- Supervisor review on every recommendation ---
  t.ok('every rec has a supervisor critique', a.recommendations.every((r) => r.supervisorReview && ['approve', 'reject', 'needs_more_data'].indexOf(r.supervisorReview.verdict) !== -1 && Array.isArray(r.supervisorReview.riskFlags) && typeof r.supervisorReview.confidenceAdjustment === 'number'));
  // A small-sample rec is held for more data.
  const lowMargin = a.recommendations.find((r) => r.type === 'low_margin_wins');
  t.ok('small-sample rec is flagged needs_more_data with reduced confidence', lowMargin && (lowMargin.supervisorReview.verdict === 'needs_more_data' || lowMargin.supervisorReview.confidenceAdjustment <= 0) && lowMargin.adjustedConfidence <= lowMargin.confidence);

  // --- Prediction Ledger link ---
  const rec0 = a.recommendations[0];
  const pred = await O.createPrediction(rec0, { actor: 'owner' });
  t.ok('prediction created + linked', pred.ok === true && !!pred.predictionId);
  const decisions = await data.list('agent_decisions');
  const pd = decisions.find((d) => d.id === pred.predictionId);
  t.ok('prediction is an agent_decision the ledger reads', pd && pd.agent === 'pricing_optimizer' && pd.recommendationId === rec0.id && typeof pd.confidence === 'number');
  const after = await O.analyze();
  const rec0b = after.recommendations.find((r) => r.id === rec0.id);
  t.eq('recommendation now links its prediction', rec0b.predictionId, pred.predictionId);

  // --- Human review is audited; AI + crew are blocked; price never changes ---
  RB.setRole('owner');
  const rev = await O.review(rec0.id, { actor: 'owner' });
  t.ok('owner review ok + persisted', rev.ok === true && rev.recommendation.status === 'reviewed');
  t.ok('review audited (REVIEW_PRICING allowed)', (await GW.recentAudit(100)).some((x) => x.action === 'REVIEW_PRICING' && x.decision === 'allowed'));
  const aiRev = await O.review(rec0.id, { origin: 'ai', actor: 'optimizer' });
  t.eq('AI cannot review/act', aiRev.error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot review (owner-only)', (await O.review(rec0.id, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  t.eq('still no price/quote mutation after reviews', JSON.stringify(data._store.quotes), beforeQuotes);

  return t.report();
};
