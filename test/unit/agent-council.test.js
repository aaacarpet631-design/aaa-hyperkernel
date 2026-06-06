/* Supervisor Council — deliberation, confidence voting, disagreement, convene, owner-gated act. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('agent-council');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/agent-council.js');
  const C = G.AAA_AGENT_COUNCIL;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  // --- deliberation: unanimous strong signals → approve, zero disagreement ---
  const strong = { estimator: { confidence: 90, risk: 15, severity: 'low' }, finance: { marginPct: 35, marginFloor: 25 }, risk: { score: 15 }, optimizer: { winRate: 0.8, segmentKey: 'x' }, marketing: { winRate: 0.7, leadSource: 'referral' }, followup: { status: 'reviewed' } };
  const d1 = C.deliberate(strong);
  t.eq('strong case → approve', d1.decision, 'approve');
  t.eq('unanimous → zero disagreement', d1.disagreement, 0);
  t.ok('high decision confidence + full quorum', d1.decisionConfidence === 100 && d1.votingCount === 6);

  // --- conflict → disagreement > 0 + cautious decision + surfaced concerns ---
  const conflict = { estimator: { confidence: 80, risk: 20 }, finance: { marginPct: 10, marginFloor: 25 }, risk: { score: 70 }, optimizer: { winRate: 0.7, segmentKey: 'x' }, marketing: { winRate: 0.2, leadSource: 'google' }, followup: { status: 'reviewed' } };
  const d2 = C.deliberate(conflict);
  t.ok('conflict raises disagreement', d2.disagreement > 0);
  t.ok('cautious decision under conflict', d2.decision === 'reject' || d2.decision === 'revise');
  t.ok('surfaces the dissenting concerns', d2.topConcerns.some((c) => /margin/.test(c)) && d2.topConcerns.some((c) => /risk/.test(c)));

  // --- abstain when a seat has no data ---
  const sparse = C.deliberate({ estimator: { confidence: 75, risk: 20 } });
  t.ok('seats without data abstain', sparse.votingCount === 1 && sparse.abstained === 5);

  // --- track record amplifies a member's weighted vote ---
  const hi = C.deliberate(conflict, { weights: { finance: 1.0 } });
  const lo = C.deliberate(conflict, { weights: { finance: 0.0 } });
  const fw = (d) => d.positions.find((p) => p.id === 'finance').voteWeight;
  t.ok('higher track record → heavier vote', fw(hi) > fw(lo));

  // --- convene on a real quote: gather, deliberate, persist, log a prediction ---
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'reviewed', confidence: 80, risk: 20, severity: 'low', marginPct: 30, leadSource: 'referral', serviceType: ['carpet_install'], jobId: 'j1' });
  const beforeQuotes = JSON.stringify(data._store.quotes);
  const conv = await C.conveneOnQuote('q1');
  t.ok('convened a session', conv.ok === true && !!conv.session.id && conv.session.status === 'pending_approval');
  t.ok('session carries the deliberation', ['approve', 'revise', 'reject'].indexOf(conv.session.decision) !== -1 && Array.isArray(conv.session.positions));
  t.ok('prediction hook logged for the ledger', !!conv.session.predictionId && (await data.list('agent_decisions')).some((x) => x.id === conv.session.predictionId && x.agent === 'agent_council' && x.kind === 'council_decision'));
  t.eq('convening mutates no quote/price', JSON.stringify(data._store.quotes), beforeQuotes);
  t.eq('bad quote → honest error', (await C.conveneOnQuote('nope')).error, 'QUOTE_NOT_FOUND');

  // --- owner acts on the decision: gateway-audited; AI + crew blocked ---
  const sid = conv.session.id;
  RB.setRole('owner');
  t.eq('AI cannot act on a council decision', (await C.act(sid, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot act (owner-only)', (await C.act(sid, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const acted = await C.act(sid, { actor: 'owner', decision: 'reject' });
  t.ok('owner can accept/override', acted.ok === true && (await C.get(sid)).status === 'reviewed');
  t.ok('override recorded', (await C.get(sid)).ownerDecision === 'reject' && (await C.get(sid)).overridden === (conv.session.decision !== 'reject'));
  t.ok('owner action audited (REVIEW_COUNCIL)', (await GW.recentAudit(100)).some((a) => a.action === 'REVIEW_COUNCIL' && a.decision === 'allowed'));

  // --- leaderboard: seats + track record + council participation ---
  await data.put('agent_decisions', 'sd1', { id: 'sd1', agent: 'estimator', confidence: 70, score: 0.8, workspaceId: 'ws_test' });
  const board = await C.leaderboard();
  t.ok('leaderboard has all seats', board.length === C.MEMBERS.length && board.every((b) => b.title));
  t.ok('leaderboard counts council votes', board.find((b) => b.agent === 'estimator').councilVotes >= 1);

  return t.report();
};
