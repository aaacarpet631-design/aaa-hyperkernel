/* Opportunity Scorer — shrinkage blend, expected value, actions, ranking, fallbacks. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('opportunity-scorer');
  const { G, data } = setupEnv();
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/opportunity-scorer.js');
  const S = G.AAA_OPPORTUNITY_SCORER;

  let n = 0;
  function seed(q) {
    n++; const id = q.id || ('q' + n);
    return data.put('quotes', id, Object.assign({
      quoteId: id, id: id, workspaceId: 'ws_test',
      createdAt: '2026-05-01T00:00:00Z'
    }, q));
  }

  // Strong 'stretching' segment: 4 won / 1 lost (referral, 77002, $1k–2.5k band).
  for (let i = 0; i < 4; i++) await seed({ status: 'won', serviceType: ['stretching'], zip: '77002', leadSource: 'referral', customerTotal: 1200, finalPrice: 1200, wonLostReason: 'value' });
  await seed({ status: 'lost', serviceType: ['stretching'], zip: '77002', leadSource: 'referral', customerTotal: 1200, wonLostReason: 'timing' });
  // Dead-cold 'carpet_install' segment: 0 won / 4 lost (google, 77005, $2.5k+ band).
  for (let i = 0; i < 4; i++) await seed({ status: 'lost', serviceType: ['carpet_install'], zip: '77005', leadSource: 'google', customerTotal: 2700, wonLostReason: 'price too high' });
  // 1-sample 100% segment (the shrinkage test): repair / 99999 / nextdoor / $500–1k.
  await seed({ status: 'won', serviceType: ['repair'], zip: '99999', leadSource: 'nextdoor', customerTotal: 600, finalPrice: 600, wonLostReason: 'value' });
  // Overall: 10 resolved, 5 won → winRate 0.5.

  // Open pipeline.
  await seed({ id: 'qa', status: 'sent', serviceType: ['stretching'], zip: '77002', leadSource: 'referral', customerTotal: 1000 });
  await seed({ id: 'qb', status: 'draft', serviceType: ['carpet_install'], zip: '77005', leadSource: 'google', customerTotal: 2600 });
  await seed({ id: 'qc', status: 'follow_up_due', serviceType: ['repair'], zip: '99999', leadSource: 'nextdoor', customerTotal: 500 });
  await seed({ id: 'qe', status: 'reviewed', serviceType: ['tile'], zip: '11111', leadSource: 'flyer', customerTotal: 100 });
  // Closed/parked — must be excluded from scoreAll.
  await seed({ id: 'qarch', status: 'archived', serviceType: ['stretching'], customerTotal: 999 });

  const approx = (a, b) => Math.abs(a - b) < 1e-9;

  // ---- qa: strong segment, all 4 dimensions match -----------------------
  // posterior per dim = (4 + 3·0.5) / (5 + 3) = 0.6875
  const a = await S.score(await G.AAA_QUOTES.get('qa'));
  t.ok('qa scored ok', a.ok === true && a.quoteId === 'qa');
  t.eq('qa method is segment_blend', a.basis.method, 'segment_blend');
  t.ok('qa probability = shrunk 0.6875', approx(a.probability, 0.6875));
  t.ok('qa segment blend beats overall rate', a.probability > a.basis.overall.winRate);
  t.eq('qa probabilityPct integer', a.probabilityPct, 69);
  t.eq('qa expectedValue = round(p × customerTotal)', a.expectedValue, 688);
  t.eq('qa amount = customerTotal', a.amount, 1000);
  t.eq('qa used all 4 dimensions', a.basis.segmentsUsed.length, 4);
  const band = a.basis.segmentsUsed.find((s) => s.dimension === 'priceBand');
  t.ok('qa price band keyed like the learning store', band && band.key === '$1k–2.5k' && band.count === 5);
  t.ok('qa basis.overall honest', a.basis.overall.winRate === 0.5 && a.basis.overall.count === 10);
  t.eq('qa confidence high (20 evidence)', a.confidence, 'high');
  t.ok('qa sent + p≥0.6 → follow_up today', a.recommendedAction.id === 'follow_up' && a.urgency === 'today');

  // ---- qc: 1-sample 100% segment must be shrunk, not certain ------------
  // posterior per dim = (1 + 1.5) / (1 + 3) = 0.625
  const c = await S.score(await G.AAA_QUOTES.get('qc'));
  t.ok('qc shrinkage: 1-sample 100% segment is NOT probability 1.0', c.probability < 1);
  t.ok('qc shrunk posterior = 0.625', approx(c.probability, 0.625));
  t.ok('qc follow_up_due → call_now now', c.recommendedAction.id === 'call_now' && c.urgency === 'now');
  t.eq('qc confidence medium (4 evidence)', c.confidence, 'medium');

  // ---- qb: cold segment → low probability → review pricing --------------
  // posterior per dim = (0 + 1.5) / (4 + 3) ≈ 0.2143
  const b = await S.score(await G.AAA_QUOTES.get('qb'));
  t.ok('qb cold segment scores below overall', b.basis.method === 'segment_blend' && b.probability < 0.5);
  t.ok('qb p<0.35 → review_pricing this_week', b.recommendedAction.id === 'review_pricing' && b.urgency === 'this_week');
  t.eq('qb expectedValue math', b.expectedValue, Math.round(b.probability * 2600 + 1e-9));

  // ---- qe: no segments match → overall rate ------------------------------
  const e = await S.score(await G.AAA_QUOTES.get('qe'));
  t.eq('qe falls back to overall_rate', e.basis.method, 'overall_rate');
  t.ok('qe probability = overall winRate, no segments claimed', e.probability === 0.5 && e.basis.segmentsUsed.length === 0);
  t.ok('qe reviewed + ok prob → send_quote today', e.recommendedAction.id === 'send_quote' && e.urgency === 'today');

  // ---- scoreAll: open-only, ranked by expectedValue ----------------------
  const all = await S.scoreAll();
  t.ok('scoreAll ok + rankedBy', all.ok === true && all.rankedBy === 'expectedValue');
  t.eq('scoreAll includes only open quotes', all.items.length, 4);
  t.ok('scoreAll excludes won/lost/archived', !all.items.some((i) => ['qarch'].indexOf(i.quoteId) !== -1));
  t.eq('scoreAll ranked desc by expectedValue', all.items.map((i) => i.quoteId).join(','), 'qa,qb,qc,qe');
  t.ok('scoreAll EVs are non-increasing', all.items.every((i, ix) => ix === 0 || all.items[ix - 1].expectedValue >= i.expectedValue));

  // ---- no data at all → stated uninformed prior --------------------------
  const { G: G2 } = setupEnv();
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/opportunity-scorer.js');
  const S2 = G2.AAA_OPPORTUNITY_SCORER;
  const empty = await S2.score({ quoteId: 'qz', status: 'draft', serviceType: ['stretching'], customerTotal: 400 });
  t.ok('no history → uninformed_prior 0.5', empty.ok && empty.basis.method === 'uninformed_prior' && empty.probability === 0.5);
  t.ok('uninformed prior is low confidence', empty.confidence === 'low' && empty.expectedValue === 200);
  const emptyAll = await S2.scoreAll();
  t.ok('scoreAll on empty store is ok+empty', emptyAll.ok === true && emptyAll.items.length === 0);

  // ---- null-safety: stores deleted ----------------------------------------
  delete G2.AAA_OUTCOME_LEARNING;
  const noLearn = await S2.scoreAll();
  t.ok('scoreAll without learning store → ok:false, no throw', noLearn.ok === false && noLearn.items.length === 0 && !!noLearn.reason);
  const noLearnScore = await S2.score({ quoteId: 'qy', status: 'sent', customerTotal: 800 });
  t.ok('score without learning store degrades to prior', noLearnScore.ok && noLearnScore.basis.method === 'uninformed_prior');
  delete G2.AAA_QUOTES;
  const noQuotes = await S2.scoreAll();
  t.ok('scoreAll without quote store → ok:false, no throw', noQuotes.ok === false && noQuotes.items.length === 0 && !!noQuotes.reason);
  const noQuote = await S2.score(null);
  t.ok('score(null) is honest', noQuote.ok === false && !!noQuote.reason);

  return t.report();
};
