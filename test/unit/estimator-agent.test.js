/* AI Estimator agent — pricing reuse, confidence/risk, recommend, supervisor, human-gated accept. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('estimator-agent');
  const { G, data } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/agents/estimator-agent.js');
  const M = G.AAA_MEASUREMENT_MODELS;
  const E = G.AAA_ESTIMATOR;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const SUP = G.AAA_SUPERVISOR;

  // --- spec contract present (rule-7 metadata) ---
  t.ok('agent SPEC complete', !!(E.SPEC && E.SPEC.agentId === 'estimator' && E.SPEC.allowedActions.length && E.SPEC.blockedActions.indexOf('finalize_price') !== -1 && E.SPEC.humanApprovalThreshold));

  // --- estimate() reuses the pricing engine + hard rules ---
  const room = M.newSession({ roomName: 'Living', length: 12, width: 12 }); // 144 ft²
  const est = E.estimate({ sessions: [room], services: ['carpet_install'], jobId: 'j1' });
  t.ok('estimate ok', est.ok === true);
  t.ok('priced > 0', est.quote.total > 0);
  t.ok('always needs human approval', est.needsHumanApproval === true);
  t.ok('has confidence + risk', typeof est.confidence === 'number' && typeof est.risk === 'number' && ['low', 'medium', 'high'].indexOf(est.severity) !== -1);
  t.ok('customer receipt hides cost internals', est.receipt.items && est.receipt.items.every((it) => !('_labor' in it)));

  // shampoo floor is honored through the engine (never below $45/room).
  const tiny = M.newSession({ roomName: 'Bath', length: 3, width: 3 }); // 9 ft²
  G.AAA_CONFIG.set({ rateCard: { min_job: 0 } });
  const sh = E.estimate({ sessions: [tiny], services: ['carpet_shampoo'] });
  t.eq('shampoo floor enforced via engine', sh.quote.total, 45);
  G.AAA_CONFIG.set({ rateCard: null });

  // --- confidence model: explicit+complete beats inferred ---
  const explicit = E.estimate({ sessions: [room], services: ['carpet_install'] });
  const inferred = E.estimate({ sessions: [room] }); // no services → inferred
  t.ok('inferred flagged', inferred.inferredServices === true && inferred.services.length > 0);
  t.ok('explicit more confident than inferred', explicit.confidence > inferred.confidence);

  // --- risk model: big thin-margin job scores higher than a tiny one ---
  const big = E.estimate({ sessions: [M.newSession({ roomName: 'Hall', length: 50, width: 40 })], services: ['carpet_install'] }); // 2000 ft²
  t.ok('large job is riskier', big.risk > sh.risk && (big.severity === 'medium' || big.severity === 'high'));
  t.ok('large job cites size or margin', big.risks.some((r) => /job|margin/i.test(r)));

  // --- guard rails ---
  t.eq('no measurements → honest error', E.estimate({ sessions: [], services: ['carpet_install'] }).error, 'NO_MEASUREMENTS');

  // --- recommend(): logs an agent_decisions record (customer-safe) ---
  const rec = await E.recommend({ sessions: [room], services: ['carpet_install'], jobId: 'j1' });
  t.ok('recommend ok + decisionId', rec.ok === true && !!rec.decisionId);
  const decisions = await data.list('agent_decisions');
  t.eq('one decision logged', decisions.length, 1);
  t.ok('decision is by estimator + has confidence', decisions[0].agent === 'estimator' && typeof decisions[0].confidence === 'number');
  t.ok('decision carries NO cost internals', !('_labor' in decisions[0]) && !('_laborTotal' in decisions[0]) && decisions[0].total != null);

  // --- supervisor scores the estimator's decision against the outcome (learning loop) ---
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', estimates: [], workspaceId: 'ws_test' });
  const acc = await E.accept({ jobId: 'j1', estimate: est, sessionIds: [room.id], origin: 'human', actor: 'owner' });
  t.ok('human accept ok', acc.ok === true && acc.entries.length >= 1);
  const outcome = { id: 'o1', jobId: 'j1', result: 'won', finalAmount: est.quote.total };
  const scored = await SUP.scoreOutcome(outcome);
  t.ok('supervisor scored the estimator decision', scored.ok === true && scored.scoredDecisions >= 1);
  t.ok('decision now has a calibration score', (await data.get('agent_decisions', rec.decisionId)).score != null);
  t.ok('estimate accuracy computed from attached estimate', typeof scored.estimateAccuracy === 'number');

  // --- human-gated accept attaches estimates + is audited; AI is blocked ---
  const job = await data.get('jobs', 'j1');
  t.ok('estimate attached to job', Array.isArray(job.estimates) && job.estimates.length >= 1);
  t.ok('attached lines are needs-review + AI_ESTIMATOR source', job.estimates.every((e) => e.needsReview === true) && job.estimates.some((e) => e.source === 'AI_ESTIMATOR'));
  const audits = await GW.recentAudit(100);
  t.ok('accept was audited (ADD_ESTIMATE allowed)', audits.some((a) => a.action === 'ADD_ESTIMATE' && a.decision === 'allowed'));

  await data.put('jobs', 'j2', { id: 'j2', customerName: 'Bob', estimates: [], workspaceId: 'ws_test' });
  const aiTry = await E.accept({ jobId: 'j2', estimate: est, origin: 'ai', actor: 'estimator' });
  t.eq('AI cannot attach an estimate', aiTry.error, 'AI_NOT_PERMITTED');
  t.eq('job untouched by blocked AI attempt', (await data.get('jobs', 'j2')).estimates.length, 0);
  t.ok('blocked AI attempt was audited', (await GW.recentAudit(100)).some((a) => a.action === 'ADD_ESTIMATE' && a.decision === 'denied' && a.reason === 'AI_NOT_PERMITTED'));

  // accept with no job → honest error
  t.eq('accept needs a job', (await E.accept({ estimate: est, origin: 'human' })).error, 'NO_JOB');

  return t.report();
};
