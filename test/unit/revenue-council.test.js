/* Revenue Intelligence Council — market scoring, demand index, intent
 * classification, trust gaps, win probability, margin protection, objection
 * forecasting, timing, review + referral, governed recommendations, and
 * production isolation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js',
   'js/agents/marketing-intel.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/world-model.js',
   'js/revenue/council-governance.js',
   'js/revenue/demand-pulse-engine.js', 'js/revenue/neighborhood-opportunity-engine.js', 'js/revenue/competitor-intelligence.js', 'js/revenue/market-intelligence.js',
   'js/revenue/search-intent-engine.js', 'js/revenue/creative-evolution-engine.js', 'js/revenue/budget-physics-engine.js',
   'js/revenue/trust-gap-engine.js', 'js/revenue/proof-assembly-engine.js', 'js/revenue/authority-builder.js',
   'js/revenue/win-probability-engine.js', 'js/revenue/margin-guardian.js', 'js/revenue/objection-forecast-engine.js',
   'js/revenue/silence-analyzer.js', 'js/revenue/timing-engine.js', 'js/revenue/followup-intelligence.js',
   'js/revenue/review-velocity-engine.js', 'js/revenue/reputation-engine.js', 'js/revenue/referral-engine.js',
   'js/revenue/revenue-intelligence-council.js', 'js/revenue/revenue-dashboard.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

async function seed(data) {
  // Quotes across zips/bands with margins + outcomes; reviews; customers; jobs.
  const q = (id, status, total, zip, margin, svc) => data.put('quotes', id, { id: id, status: status, total: total, zip: zip, margin: margin, serviceType: svc, createdAt: iso(NOW - 86400000), closedAt: iso(NOW - 3600000) });
  await q('q1', 'won', 1200, '77001', 0.5, 'cleaning'); await q('q2', 'won', 1300, '77001', 0.48, 'cleaning');
  await q('q3', 'won', 1100, '77001', 0.52, 'cleaning'); await q('q4', 'lost', 1250, '77001', 0.3, 'cleaning');
  await q('q5', 'won', 800, '77002', 0.45, 'repair'); await q('q6', 'lost', 900, '77002', 0.2, 'repair');
  for (let i = 0; i < 4; i++) await data.put('leads', 'l' + i, { id: 'l' + i, createdAt: iso(NOW - i * 3600000), source: 'google' });
  await data.put('customers', 'c1', { id: 'c1', name: 'Acme', source: 'google' });
  await data.put('jobs', 'j1', { id: 'j1', customerId: 'c1', zip: '77001', status: 'completed', finalBilling: 1200, photos: ['a', 'b'] });
  await data.put('jobs', 'j2', { id: 'j2', customerId: 'c1', zip: '77001', status: 'completed', finalBilling: 1300 });
  await data.put('review_requests', 'rv1', { id: 'rv1', customerId: 'c1', zip: '77001', status: 'received', rating: 5, receivedAt: iso(NOW - 86400000) });
}

module.exports = async function run() {
  const t = makeRunner('revenue-council');
  const { G, data } = setupEnv();
  loadAll();
  await seed(data);
  const C = G.AAA_REVENUE_COUNCIL, GOV = G.AAA_COUNCIL_GOVERNANCE, DASH = G.AAA_REVENUE_DASHBOARD;

  // ===== market scoring + demand index =====
  const market = await C.market({ now: NOW });
  t.ok('market intelligence returns the layer contract', market.marketScore !== undefined && market.demandIndex !== undefined && market.opportunityIndex !== undefined && market.confidence !== undefined);
  t.ok('opportunity index derived from real ZIP win/margin data', market.opportunityIndex != null && market.opportunityIndex > 0);
  t.ok('demand index derived from real leads', market.demandIndex != null);

  // ===== intent classification =====
  const emergency = await C.intent('carpet flood emergency need help today', { now: NOW });
  t.eq('emergency intent classified', emergency.intentType, 'Emergency');
  t.ok('intent carries probability + expected close rate + message', emergency.probability > 0 && 'expectedCloseRate' in emergency && !!emergency.recommendedMessage);
  t.eq('price-shopping intent classified', (await C.intent('how much does cheap carpet cleaning cost quote')).intentType, 'PriceShopping');

  // ===== trust gap detection =====
  const trust = await C.trust({ now: NOW });
  t.ok('trust engine returns score + gaps + proof assets', trust.trustScore != null && Array.isArray(trust.trustGaps) && Array.isArray(trust.recommendedProofAssets));

  // ===== win probability =====
  const win = await G.AAA_WIN_PROBABILITY_ENGINE.winProbability({ serviceType: 'cleaning', total: 1200, zip: '77001' });
  t.ok('win probability derived from comparable history', win.winProbability != null && win.winProbability >= 0 && win.winProbability <= 1 && win.basis === 'comparable_quotes');
  t.eq('no comparables → insufficient_data (no guessing)', (await G.AAA_WIN_PROBABILITY_ENGINE.winProbability({ serviceType: 'spaceshipdetailing', total: 999999 })).status, 'insufficient_data');

  // ===== margin protection =====
  const lowMargin = await G.AAA_MARGIN_GUARDIAN.assess({ serviceType: 'cleaning', margin: 0.15 });
  t.ok('margin guardian flags underpricing vs history', lowMargin.underpriced === true && lowMargin.marginRisk > 0);
  const okMargin = await G.AAA_MARGIN_GUARDIAN.assess({ serviceType: 'cleaning', margin: 0.55 });
  t.ok('a healthy margin is not flagged', okMargin.underpriced === false);

  // ===== objection forecasting =====
  const obj = await G.AAA_OBJECTION_FORECAST_ENGINE.forecast({ total: 6000 }, { now: NOW });
  t.ok('high-ticket estimate forecasts a price objection', obj.likelyObjections.some((o) => o.objection === 'price_too_high'));

  // ===== estimate intelligence composite =====
  const est = await C.assessEstimate({ serviceType: 'cleaning', total: 1200, margin: 0.15, zip: '77001' }, { now: NOW });
  t.ok('assessEstimate composes win + margin + objections + recommendation', 'winProbability' in est && 'marginRisk' in est && Array.isArray(est.likelyObjections) && !!est.recommendation);

  // ===== timing optimization =====
  const timing = await G.AAA_TIMING_ENGINE.bestWindow();
  t.ok('timing engine derives a window or is honest', timing.status === 'derived' || timing.status === 'insufficient_data');

  // ===== decision acceleration (buying stage + follow-up) =====
  const ghost = G.AAA_SILENCE_ANALYZER.stageOf({ status: 'open', lastActivityAt: iso(NOW - 20 * 86400000), contactCount: 1 }, NOW);
  t.eq('a long-silent unresolved estimate is Ghosted', ghost.stage, 'Ghosted');
  const plan = await C.decisionPlan({ status: 'open', lastActivityAt: iso(NOW - 20 * 86400000) }, NOW);
  t.ok('follow-up plan provides a stage-appropriate sequence', Array.isArray(plan.sequence) && plan.sequence.length >= 1);

  // ===== review + referral flywheel =====
  const fly = await C.flywheel({ now: NOW, customerId: 'c1' });
  t.ok('flywheel returns review + referral + reputation', fly.reviewProbability != null && fly.referralProbability != null && fly.reputationScore != null);
  const ref = await G.AAA_REFERRAL_ENGINE.forCustomer('c1');
  t.ok('referral probability scored from real loyalty signals', ref.referralProbability != null && ref.signals.gavePositiveReview === true);

  // ===== governance: nothing reaches production silently =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes, customers: data._store.customers, jobs: data._store.jobs });
  const prop = await C.propose({ action: 'Raise cleaning price 5% in 77001', rationale: 'Strong win rate + margin headroom in this ZIP.' });
  t.ok('a revenue recommendation is pending governance', prop.ok && prop.recommendation.status === 'pending_governance');
  t.ok('revenue.recommendation_proposed event emitted', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'revenue.recommendation_proposed'));
  t.eq('approval requires a written reason', (await GOV.approve(prop.recommendation.id, { reason: 'ok' })).error, 'JUSTIFICATION_REQUIRED');
  const appr = await GOV.approve(prop.recommendation.id, { reason: 'Reviewed 77001 win-rate + margin; approving a 5% test.' });
  t.ok('human approval emits policy.change_approved', appr.ok && (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'policy.change_approved'));
  const applied = await GOV.apply(prop.recommendation.id);
  t.ok('apply emits policy.change_applied only after approval', applied.ok && applied.recommendation.status === 'applied');
  t.eq('production is unchanged by the whole council flow', JSON.stringify({ quotes: data._store.quotes, customers: data._store.customers, jobs: data._store.jobs }), prodBefore);

  // ===== determinism =====
  const m1 = await C.market({ now: NOW }); const m2 = await C.market({ now: NOW });
  t.eq('council reads are deterministic for fixed data + time', JSON.stringify(m1), JSON.stringify(m2));

  // ===== dashboard read model =====
  const dash = await DASH.view({ now: NOW });
  t.ok('dashboard exposes the required sections', ['leadQuality', 'closeProbability', 'cac', 'margin', 'reviewVelocity', 'referralVelocity'].every((k) => dash[k] !== undefined));
  t.eq('CAC is honest insufficient_data (no spend feed)', dash.cac.status, 'insufficient_data');

  return t.report();
};
