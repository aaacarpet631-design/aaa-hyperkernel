/* AI Operations Command Center — unified action queue, summary, digest, null-tolerance. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ai-operations-center');
  const { G, data } = setupEnv();
  load('js/intelligence/ai-operations-center.js');
  const OPS = G.AAA_AI_OPS;

  // ===== null-tolerance: no modules → empty queue, never throws =====
  const q0 = await OPS.actionQueue();
  t.ok('empty queue with no modules', Array.isArray(q0) && q0.length === 0);
  const s0 = await OPS.summary();
  t.ok('summary degrades gracefully', s0.ok === true && s0.pendingDecisions === 0);
  const d0 = await OPS.digest();
  t.ok('digest says all-clear when nothing pending', /All clear/.test(d0.headline));

  // ===== wire up pending work across modules =====
  G.AAA_PRICING_OPTIMIZER = { analyze: async () => ({ recommendations: [{ id: 'rec1', title: 'Raise band', status: 'open', confidence: 60, adjustedConfidence: 65, risk: 35 }, { id: 'rec2', title: 'Reviewed one', status: 'reviewed', confidence: 50, risk: 20 }] }) };
  G.AAA_AGENT_COUNCIL = { list: async () => [{ id: 'cs1', status: 'pending_approval', decision: 'revise', disagreement: 40, customerName: 'Jane' }, { id: 'cs2', status: 'reviewed', decision: 'approve' }] };
  G.AAA_EXECUTIVE_COUNCIL = { list: async () => [{ id: 'exr1', title: 'Hire crew', decision: 'reject', riskScore: 70, objections: [{ seat: 'Finance' }] }] };
  G.AAA_CALIBRATION_REGISTRY = { listProposals: async () => [{ id: 'cp1', agent: 'pricing_optimizer', confidenceBias: 5 }] };
  G.AAA_PRIVACY = { listRequests: async () => [{ id: 'er1', subjectType: 'customer', subjectId: 'c1', reason: 'request' }] };
  G.AAA_TRANSPORT = { pendingApproval: async () => [{ id: 'm1', category: 'review', channel: 'sms', to: '+1555' }] };
  G.AAA_RELIABILITY = { incidents: async () => [{ id: 'inc1', title: 'Transport failure rate critical', severity: 'crit', firstSeenAt: '2026-06-01' }], health: async () => ({ status: 'crit', score: 60 }) };
  G.AAA_GOVERNANCE = { listActive: async () => [{ id: 'gv1' }, { id: 'gv2' }] };
  G.AAA_EVENT_BUS = { analytics: async () => ({ total: 42 }) };
  G.AAA_OUTCOME_INTELLIGENCE = { scoreboard: async () => [{ agent: 'pricing_optimizer', accuracy: 80 }] };
  await data.put('agent_decisions', 'd1', { id: 'd1', agent: 'pricing_optimizer' });
  await data.put('agent_decisions', 'd2', { id: 'd2', agent: 'estimator' });

  // ===== action queue aggregates only OPEN/pending items =====
  const q = await OPS.actionQueue();
  const kinds = q.map((x) => x.kind);
  t.ok('aggregates every pending source', ['pricing', 'council', 'executive', 'calibration', 'privacy', 'transport', 'incident'].every((k) => kinds.indexOf(k) !== -1));
  t.ok('excludes already-reviewed items', !q.some((x) => x.id === 'rec2') && !q.some((x) => x.id === 'cs2'));
  t.ok('most urgent first (incident/privacy/executive before pricing)', q[0].priority >= q[q.length - 1].priority && q[0].kind !== 'pricing');
  t.ok('each item deep-links to its module', q.every((x) => !!x.openModule));
  t.ok('incident carries severity', q.find((x) => x.kind === 'incident').severity === 'crit');

  // ===== summary rolls it up =====
  const s = await OPS.summary();
  t.eq('pending decisions counted', s.pendingDecisions, q.length);
  t.ok('summary breaks down by kind', s.byKind.executive === 1 && s.byKind.incident === 1);
  t.ok('summary includes health + governance + events + activity', s.health.status === 'crit' && s.governance.activeVersions === 2 && s.events.total === 42 && s.agentActivity.decisions === 2 && s.agentActivity.scoredAgents === 1);

  // ===== digest briefs the owner with priorities =====
  const d = await OPS.digest();
  t.ok('digest headline counts decisions + flags critical health', /decision\(s\) need you/.test(d.headline) && /CRITICAL/.test(d.headline));
  t.ok('digest lists the top priorities (incident first)', d.priorities.length > 0 && d.priorities[0].kind === 'incident');

  // ===== a failing module does not break the center =====
  G.AAA_EXECUTIVE_COUNCIL = { list: async () => { throw new Error('boom'); } };
  const qResilient = await OPS.actionQueue();
  t.ok('a throwing module is skipped, others still aggregate', qResilient.some((x) => x.kind === 'incident') && !qResilient.some((x) => x.kind === 'executive'));

  return t.report();
};
