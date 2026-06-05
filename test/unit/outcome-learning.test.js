/* Outcome Learning Store — aggregation by segment, follow-up, malformed protection. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const BASE = Date.parse('2026-05-01T00:00:00Z');
function iso(days) { return new Date(BASE + days * 86400000).toISOString(); }

module.exports = async function run() {
  const t = makeRunner('outcome-learning');
  const { G, data } = setupEnv();
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  const L = G.AAA_OUTCOME_LEARNING;

  // Seed resolved quotes covering every segment dimension.
  let n = 0;
  function seed(q) {
    n++; const id = 'q' + n;
    const won = q.status === 'won';
    const rec = Object.assign({
      quoteId: id, id: id, workspaceId: 'ws_test',
      serviceType: ['carpet_install'], zip: '77002', leadSource: 'referral',
      customerTotal: 1500, finalPrice: won ? 1500 : null, marginPct: 30, risk: 20,
      wonLostReason: won ? 'value' : 'price too high',
      sentAt: iso(0), resolvedAt: iso(q.days != null ? q.days : (won ? 1 : 5)),
      statusHistory: [{ status: 'sent', at: iso(0) }].concat(q.followUp ? [{ status: 'follow_up_due', at: iso(0.5) }] : []).concat([{ status: q.status, at: iso(q.days != null ? q.days : (won ? 1 : 5)) }])
    }, q);
    return data.put('quotes', id, rec);
  }

  // Referral/install/77002 wins (strong segment).
  await seed({ status: 'won', days: 1, followUp: true });
  await seed({ status: 'won', days: 1, followUp: true });
  await seed({ status: 'won', days: 1, risk: 22 });
  await seed({ status: 'won', days: 1, customerTotal: 1800, finalPrice: 1800, marginPct: 10 }); // low-margin win
  // Google/install/77005 losses at $2.5k+ (weak lead source + loss-heavy band).
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2600, marginPct: 25, risk: 40, wonLostReason: 'price too high', days: 5 });
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2700, marginPct: 25, risk: 45, wonLostReason: 'price too high', days: 6 });
  await seed({ status: 'lost', zip: '77005', leadSource: 'google', customerTotal: 2800, marginPct: 25, risk: 40, wonLostReason: 'timing', days: 5 });
  // High-risk carpet_repair/77010/yelp.
  await seed({ status: 'won', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 900, finalPrice: 900, marginPct: 35, risk: 70, days: 2 });
  await seed({ status: 'lost', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 950, marginPct: 35, risk: 75, wonLostReason: 'scope', days: 4 });
  await seed({ status: 'lost', serviceType: ['carpet_repair'], zip: '77010', leadSource: 'yelp', customerTotal: 1000, marginPct: 30, risk: 70, wonLostReason: 'scope', days: 4 });
  // Non-resolved (must be excluded) + a malformed quote (must not throw).
  await seed({ status: 'draft' });
  await data.put('quotes', 'qbad', { quoteId: 'qbad', id: 'qbad', workspaceId: 'ws_test', status: 'won' }); // missing everything else

  const a = await L.aggregate();
  t.ok('aggregate ok', a.ok === true);
  t.eq('overall resolved excludes draft', a.overall.resolved, 11); // 10 seeded resolved + qbad won
  t.ok('overall win rate computed', a.overall.winRate != null && a.overall.winRate > 0 && a.overall.winRate < 1);

  const zip77002 = a.byZip.find((g) => g.key === '77002');
  t.ok('zip 77002 is a strong win segment', zip77002 && zip77002.winRate === 1 && zip77002.count === 4);
  const google = a.byLeadSource.find((g) => g.key === 'google');
  t.ok('google lead source is weak', google && google.winRate === 0 && google.count === 3);
  const band = a.byPriceBand.find((g) => g.key === '$2.5k+');
  t.ok('$2.5k+ band is loss-heavy', band && band.winRate === 0 && band.count === 3);
  const thin = a.byMarginBand.find((g) => g.key === 'thin (<15%)');
  t.ok('thin-margin band captured the low-margin win', thin && thin.count >= 1);
  const highRisk = a.byRiskBand.find((g) => g.key === 'high');
  t.ok('high risk band has the risky jobs', highRisk && highRisk.count === 3);

  t.ok('loss reasons tallied', a.lossReasons.find((r) => r.reason === 'price too high').count === 2);
  t.eq('low-margin wins surfaced', a.lowMarginWins.length, 1);
  t.eq('high-risk resolved surfaced', a.highRiskResolved.length, 3);
  t.ok('follow-up timing computed (losses slower)', a.followUp.avgDaysToLoss > a.followUp.avgDaysToWin);
  t.ok('follow-up effectiveness split', a.followUp.withFollowUp.count === 2 && a.followUp.withoutFollowUp.count >= 1);

  // Malformed quote was counted without throwing and bucketed as unknown.
  t.ok('malformed quote handled (unknown buckets exist)', a.byZip.some((g) => g.key === 'unknown') && a.byPriceBand.some((g) => g.key === 'unknown'));

  // Empty state.
  const { G: G2, data: d2 } = setupEnv();
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  const empty = await G2.AAA_OUTCOME_LEARNING.aggregate();
  t.ok('empty state is honest', empty.ok === true && empty.overall.resolved === 0 && empty.overall.winRate === null && empty.byZip.length === 0 && empty.lowMarginWins.length === 0);

  return t.report();
};
