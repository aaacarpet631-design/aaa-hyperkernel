/* Outcome Intelligence — event ingest, agent scoring, accuracy trend, pattern extraction. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('outcome-intelligence');
  const { G, data } = setupEnv();
  load('js/intelligence/outcome-intelligence.js');
  const OI = G.AAA_OUTCOME_INTELLIGENCE;

  // seed resolved quotes
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'won', marginPct: 30, sentAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-01-03T00:00:00Z', customerId: 'c1' });
  await data.put('quotes', 'q2', { id: 'q2', quoteId: 'q2', workspaceId: 'ws_test', status: 'lost', sentAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-01-05T00:00:00Z', customerId: 'c2' });
  await data.put('quotes', 'q3', { id: 'q3', quoteId: 'q3', workspaceId: 'ws_test', status: 'won', marginPct: 20, sentAt: '2026-01-02T00:00:00Z', resolvedAt: '2026-01-04T00:00:00Z', customerId: 'c3' });

  // ===== ingest derives a normalized outcome-event stream (idempotent) =====
  const ing = await OI.ingest();
  t.ok('ingest derives outcome events from resolved quotes', ing.ok === true && ing.added >= 7);
  const again = await OI.ingest();
  t.eq('ingest is idempotent (no duplicates)', again.added, 0);
  const evs = await OI.events();
  t.ok('stream has won/lost/margin/response events', evs.some((e) => e.type === 'quote_won') && evs.some((e) => e.type === 'quote_lost') && evs.some((e) => e.type === 'margin_achieved') && evs.some((e) => e.type === 'response_time'));
  t.eq('unknown event type rejected', (await OI.record('not_a_type', {})).error, 'UNKNOWN_TYPE');

  // ===== metrics summarize the stream =====
  const m = await OI.metrics();
  t.ok('conversion derived from won/lost', m.conversion === 67 && m.byType.quote_won === 2);
  t.eq('avg margin computed', m.avgMargin, 25);
  t.eq('avg response time computed', m.avgResponseDays, 2.7);

  // ===== agent scoring from closures + supervisor + decisions =====
  // closures (validation-based accuracy) for pricing_optimizer
  G.AAA_PREDICTION_CLOSURE = { calibrationSummary: async () => ({ agents: [{ agent: 'pricing_optimizer', validated: 8, contradicted: 2, validationRate: 0.8, closures: 10 }] }) };
  // supervisor track record for another agent
  G.AAA_SUPERVISOR = { metrics: async () => ({ perAgent: { estimator: { decisions: 5, avgScore: 0.6, scoredCount: 5 }, follow_up: { decisions: 3, avgScore: 0.4, scoredCount: 2 } } }) };
  await data.put('agent_decisions', 'd1', { id: 'd1', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 70 });
  await data.put('agent_decisions', 'd2', { id: 'd2', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 60 });

  const sc = await OI.scoreAgents();
  t.ok('scores every agent seen', sc.ok === true && sc.scoreboard.length >= 3);
  const board = await OI.scoreboard();
  const po = board.find((b) => b.agent === 'pricing_optimizer');
  t.ok('closure-backed accuracy computed (8/10 = 80%)', po.accuracy === 80 && po.sample === 10);
  t.ok('decision volume counted', po.decisions >= 2);
  const est = board.find((b) => b.agent === 'estimator');
  t.ok('supervisor avgScore fills agents without closures', est.accuracy === 60);
  t.ok('scoreboard ranks by accuracy (best first)', board[0].accuracy >= board[board.length - 1].accuracy || board[0].accuracy === po.accuracy);

  // accuracy snapshots accumulate for a trend
  await OI.scoreAgents();
  t.ok('agent accuracy snapshots build a trend', (await OI.agentTrend('pricing_optimizer')).length === 2);

  // ===== pattern extraction (advisory) =====
  G.AAA_OUTCOME_LEARNING = { aggregate: async () => ({
    overall: { winRate: 0.6, resolved: 10, avgMarginPct: 25 },
    byServiceType: [{ key: 'carpet_install', count: 6, winRate: 0.75, avgMarginPct: 28 }, { key: 'unknown', count: 4, winRate: 0.5 }],
    byZip: [{ key: '90210', count: 3, avgMarginPct: 40 }],
    byLeadSource: [{ key: 'referral', count: 5, winRate: 0.8 }]
  }) };
  const pat = await OI.extractPatterns();
  t.ok('patterns extracted from aggregates', pat.ok === true && pat.patterns >= 3);
  const patterns = await OI.patterns();
  t.ok('a strong service-type winRate pattern is captured', patterns.some((p) => p.dimension === 'serviceType' && p.key === 'carpet_install' && p.value === 75));
  t.ok('low-sample / unknown segments are excluded', !patterns.some((p) => p.key === 'unknown'));

  // ===== refresh chains it all + summarizes =====
  const summary = await OI.refresh();
  t.ok('refresh returns a coherent summary', summary.ok === true && summary.scoredAgents >= 3 && summary.patterns >= 3 && summary.totalEvents >= 7);

  return t.report();
};
