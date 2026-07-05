/* Workforce Runner — exactly-one execution in an at-least-once world.
 *
 * The Slice 2 proofs, against the REAL lease/registry/queue/scheduler/
 * mission stack (only model seams stubbed): two overlapping runners resolve
 * to ONE executing tick (the loser told TICK_LEASE_HELD + holder); a
 * redelivered due-mark is idempotent (DUPLICATE_TICK, one job, one spend);
 * budget ceilings block BEFORE any model call; the concurrency cap defers —
 * and NAMES — the overflow; repeated failure quarantines the agent and
 * dead-letters its job (revival is explicit and human); the kill switch is
 * honored by the runner itself, defense in depth. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('workforce-runner');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-05T09:00:00.000Z' });
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/core/tenant-guard.js');
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/agents/agent-registry.js');
  load('js/agents/global-desk.js');
  load('js/agents/planning-desk.js');
  load('js/agents/review-protocol.js');
  load('js/agents/mission-manager.js');
  load('js/agents/workforce-registry.js');
  load('js/agents/workforce-queue.js');
  load('js/agents/workforce-scheduler.js');
  load('js/agents/workforce-lease.js');
  load('js/agents/workforce-runner.js');
  const REG = G.AAA_WORKFORCE_REGISTRY, Q = G.AAA_WORKFORCE_QUEUE, R = G.AAA_WORKFORCE_RUNNER;
  const L = G.AAA_WORKFORCE_LEASE;

  // stubs at the model seams only
  let modelCalls = 0;
  let failAgentOs = false;
  G.AAA_AGENT_OS = { runAgent: async (roleId) => { if (failAgentOs) return { ok: false, error: 'AI_NOT_CONFIGURED' }; modelCalls++; return { ok: true, agent: roleId, decisionId: 'd', recommendation: 'draft', rationale: 'r', confidence: 82, risks: [], next_actions: [] }; } };
  G.AAA_PLANNING_DESK.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { objective: 'x', phases: [{ phase_id: 'p1', name: 'Draft', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] } }) });
  G.AAA_REVIEW_PROTOCOL.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 } }) });

  await REG.register({ id: 'drafter', name: 'Drafter', department: 'sales', purpose: 'p', mission: 'Draft recommendations. Drafts only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });

  // ===== the runner honors the kill switch itself (defense in depth) =====
  const off = await R.runTick({ owner: 'runner_a' });
  t.ok('kill switch off → runner runs nothing', off.ran === 0 && off.skipped === 'CONTINUOUS_AGENTS_DISABLED');
  cfg.set({ continuousAgentsEnabled: true });

  // ===== two overlapping runners → exactly one executing tick =====
  // runner_b grabs the tick lease first (simulating an in-flight tick)…
  await L.acquire(R.TICK_LEASE, { owner: 'runner_b', ttlMs: 60000 });
  const contested = await R.runTick({ owner: 'runner_a' });
  t.ok('the second runner is told who holds the tick', contested.ran === 0 && contested.skipped === 'TICK_LEASE_HELD' && contested.holder === 'runner_b');
  await L.release(R.TICK_LEASE, 'runner_b');
  const tick1 = await R.runTick({ owner: 'runner_a' });
  t.ok('the free runner executes the tick', tick1.ran === 1 && tick1.results[0].status === 'completed' && tick1.owner === 'runner_a');
  t.ok('the tick lease is released afterwards', (await R.runTick({ owner: 'runner_b' })).skipped !== 'TICK_LEASE_HELD');

  // ===== idempotency: a redelivered due-mark creates NO second job =====
  const agent = await REG.get('drafter');
  const jobsBefore = (await Q.list({ agentId: 'drafter' })).length;
  const spendBefore = modelCalls;
  // force the old due-mark back (as a raced runner would see it)
  const stale = Object.assign({}, agent, { nextRunAt: '2026-07-05T09:00:00.000Z' });
  await G.AAA_DATA.put('workforce_agents', 'drafter', stale);
  const replay = await R.runTick({ owner: 'runner_b', at: '2026-07-05T09:00:00.000Z' });
  t.ok('the replayed tick found the duplicate and made NO job', replay.results[0].error === 'DUPLICATE_TICK' && (await Q.list({ agentId: 'drafter' })).length === jobsBefore);
  t.eq('…and NO second model spend', modelCalls, spendBefore);
  t.ok('the duplicate names the existing job', !!replay.results[0].jobId);

  // ===== budget ceiling blocks BEFORE the model =====
  await REG.register({ id: 'spender', name: 'Spender', department: 'sales', purpose: 'p', mission: 'Draft things. Drafts only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true, budgetUsd: 1 });
  await G.AAA_DATA.put('workforce_agents', 'spender', Object.assign(await REG.get('spender'), { costUsd: 1.5 }));
  const before = modelCalls;
  const broke = await G.AAA_WORKFORCE_SCHEDULER.runNow('spender');
  t.eq('over-budget agent is blocked', broke.error, 'BUDGET_EXCEEDED');
  const brokeJob = await Q.get(broke.jobId);
  t.ok('the block names the spend vs the cap', brokeJob.status === 'blocked' && /1.5 of \$1/.test(brokeJob.governance.notes[0]));
  t.eq('…and NO model was called', modelCalls, before);

  // ===== concurrency cap defers and NAMES the overflow =====
  await REG.register({ id: 'a1', name: 'A1', department: 'sales', purpose: 'p', mission: 'Draft only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });
  await REG.register({ id: 'a2', name: 'A2', department: 'sales', purpose: 'p', mission: 'Draft only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });
  await REG.register({ id: 'a3', name: 'A3', department: 'sales', purpose: 'p', mission: 'Draft only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });
  cfg.set({ workforceMaxConcurrent: 2 });
  const capped = await R.runTick({ owner: 'runner_a', at: '2026-07-05T09:00:30.000Z' });
  t.ok('cap runs two, defers the rest BY NAME', capped.ran === 2 && capped.deferred.length >= 1);
  const nextTick = await R.runTick({ owner: 'runner_a', at: '2026-07-05T09:00:40.000Z' });
  t.ok('deferred agents are still due next tick (never dropped)', nextTick.ran >= 1);

  // ===== dead-letter: repeated failure quarantines, revival is human =====
  cfg.set({ workforceMaxConcurrent: 10, workforceQuarantineAfter: 3 });
  await REG.register({ id: 'flaky', name: 'Flaky', department: 'sales', purpose: 'p', mission: 'Draft only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });
  failAgentOs = true;
  await G.AAA_WORKFORCE_SCHEDULER.runNow('flaky');
  await G.AAA_WORKFORCE_SCHEDULER.runNow('flaky');
  const third = await G.AAA_WORKFORCE_SCHEDULER.runNow('flaky');
  failAgentOs = false;
  const flaky = await REG.get('flaky');
  t.ok('third consecutive failure quarantines the agent', flaky.status === 'quarantined' && flaky.enabled === false);
  t.eq('its last job is dead-lettered', (await Q.get(third.jobId)).status, 'dead_letter');
  t.ok('the quarantine is audited with the reason', (await G.AAA_DATA.list('governance_audit')).some((e) => e.type === 'workforce.agent.quarantined' && /3 consecutive/.test(e.payload.reason)));
  t.eq('a quarantined agent cannot run', (await G.AAA_WORKFORCE_SCHEDULER.runNow('flaky')).error, 'AGENT_DISABLED');
  const revived = await REG.setEnabled('flaky', true);
  t.ok('revival is an explicit human decision', revived.agent.enabled === true && revived.agent.status === 'idle');
  t.ok('a dead-lettered job can be explicitly requeued', (await Q.transition(third.jobId, 'queued')).ok === true);

  // ===== the audit chain holds across all of it =====
  t.ok('audit chain verifies end-to-end', (await G.AAA_AUDIT_LEDGER.verify()).ok === true);

  return t.report();
};
