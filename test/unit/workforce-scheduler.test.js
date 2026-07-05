/* Workforce Scheduler — deterministic ticks, not timers.
 *
 * The required proofs, against the REAL registry/queue/mission-manager/
 * guard/gate/escalation/envelope/review stack (only model seams stubbed):
 * the global kill switch (default OFF) blocks all scheduled and event
 * execution; disabled agents never run (scheduled or manual); a due agent
 * queues exactly one job per tick; not-due agents do not run; risk above
 * ceiling and tenant violations block BEFORE any model call; a missing
 * governance module refuses the whole tick; a failing agent fails its own
 * job without crashing the tick; approval missions park jobs in
 * awaiting_approval (the workforce cannot self-approve); rejected critical
 * reviews block completion; and Run now is RBAC-gated and fully governed. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('workforce-scheduler');
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
  const REG = G.AAA_WORKFORCE_REGISTRY, Q = G.AAA_WORKFORCE_QUEUE, S = G.AAA_WORKFORCE_SCHEDULER;
  const PD = G.AAA_PLANNING_DESK, RP = G.AAA_REVIEW_PROTOCOL, ENV = G.AAA_DECISION_ENVELOPE;

  // ---- stubs at the model seams only --------------------------------------
  let modelCalls = 0;
  let failAgentOs = false;
  G.AAA_AGENT_OS = { runAgent: async (roleId) => { if (failAgentOs) return { ok: false, error: 'AI_NOT_CONFIGURED' }; modelCalls++; return { ok: true, agent: roleId, decisionId: 'd', recommendation: 'draft recommendation', rationale: 'grounded', confidence: 82, risks: [], next_actions: [] }; } };
  let plan = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Draft', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] };
  PD.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: plan }) });
  let reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  RP.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: reviewVerdict }) });

  await REG.register({ id: 'drafter', name: 'Drafter', department: 'sales', purpose: 'p', mission: 'Draft follow-up recommendations. Drafts only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule', 'event:lead.created'] });

  // ===== KILL SWITCH: default OFF blocks everything continuous =====
  t.eq('kill switch defaults OFF', S.enabled(), false);
  await REG.setEnabled('drafter', true);
  const off = await S.runDue();
  t.ok('runDue with switch off runs NOTHING', off.ran === 0 && off.skipped === 'CONTINUOUS_AGENTS_DISABLED');
  const offEvt = await S.onEvent('lead.created', { id: 'l1' });
  t.ok('events with switch off run NOTHING', offEvt.ran === 0 && offEvt.skipped === 'CONTINUOUS_AGENTS_DISABLED');
  t.eq('no jobs were queued while off', (await Q.list()).length, 0);
  t.eq('and no model was ever called', modelCalls, 0);

  // ===== a due agent runs EXACTLY ONE job per tick =====
  cfg.set({ continuousAgentsEnabled: true });
  const tick1 = await S.runDue();
  t.ok('due agent ran once and completed', tick1.ran === 1 && tick1.results[0].status === 'completed');
  t.eq('exactly one job exists', (await Q.list({ agentId: 'drafter' })).length, 1);
  t.ok('the job carries its mission', !!(await Q.list({ agentId: 'drafter' }))[0].missionId);
  t.eq('model was called for the delegated work', modelCalls, 1);

  // ===== not-due agents do not run =====
  const tick2 = await S.runDue(); // nextRunAt advanced to 10:00; clock still 09:00
  t.eq('not-due agent does not run again', tick2.ran, 0);
  t.eq('still exactly one job', (await Q.list({ agentId: 'drafter' })).length, 1);
  const tick3 = await S.runDue({ at: '2026-07-05T10:00:00.000Z' });
  t.eq('at the persisted nextRunAt it is due again', tick3.ran, 1);

  // ===== disabled agent never runs — scheduled or manual =====
  await REG.setEnabled('drafter', false);
  t.eq('disabled agent is not due', (await S.runDue({ at: '2026-07-06T00:00:00.000Z' })).ran, 0);
  t.eq('disabled agent refuses Run now', (await S.runNow('drafter')).error, 'AGENT_DISABLED');
  await REG.setEnabled('drafter', true);

  // ===== risk ceiling blocks BEFORE any model call =====
  await REG.register({ id: 'risky', name: 'Risky', department: 'operations', purpose: 'p', mission: 'Send email blast to all customers and charge cards.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true });
  const before = modelCalls;
  const riskTick = await S.runNow('risky');
  t.eq('mission above the ceiling is blocked', riskTick.error, 'RISK_CEILING');
  const riskyJob = (await Q.list({ agentId: 'risky' }))[0];
  t.ok('the blocked job names risk vs ceiling', riskyJob.status === 'blocked' && riskyJob.error === 'RISK_CEILING' && /exceeds ceiling/.test(riskyJob.governance.notes[0]));
  t.eq('and NO model was called', modelCalls, before);

  // ===== tenant violation blocks before any model call =====
  await REG.register({ id: 'leaky', name: 'Leaky', department: 'sales', purpose: 'p', mission: 'Draft a comparison. Drafts only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule'], enabled: true, dataScopes: [{ source: 'competitor tenant', workspaceId: 'ws_other' }] });
  const tenantRun = await S.runNow('leaky');
  t.eq('foreign tenant scope refuses the mission', tenantRun.error, 'TENANT_BOUNDARY');
  t.ok('the job failed before any model call', (await Q.list({ agentId: 'leaky' }))[0].status === 'failed' && modelCalls === before);

  // ===== approval mission pauses — the workforce cannot self-approve =====
  plan = { objective: 'x', phases: [{ phase_id: 'gate', name: 'Owner sign-off', mode: 'approval', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'ceo' }] }], blocking_issues: [] };
  const gated = await S.runNow('drafter');
  t.eq('approval mission parks the job', gated.status, 'awaiting_approval');
  const gatedJob = await Q.get(gated.jobId);
  t.ok('the pause is honest and named', /human approval/.test(gatedJob.outputSummary) && gatedJob.governance.notes.some((n) => n.indexOf('cannot approve its own work') !== -1));
  const mission = await G.AAA_MISSION_MANAGER.get(gated.missionId);
  const pendEnvId = mission.pendingApprovals[0].envelopeId;
  t.ok('the gate envelope carries no HUMAN approval', (await ENV.get(pendEnvId)).approval.status !== 'approved');
  t.eq('the workforce cannot pass the gate itself', (await G.AAA_MISSION_MANAGER.approvePhase(gated.missionId, 'gate', pendEnvId)).error, 'ENVELOPE_NOT_APPROVED');

  // ===== rejected critical review blocks completion =====
  plan = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Draft', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] };
  reviewVerdict = { decision: 'reject', severity: 'critical', defects: [{ type: 'policy', description: 'bad draft', fix_instruction: 'redo' }], confidence: 0.9 };
  const rejected = await S.runNow('drafter');
  t.eq('critical review rejection blocks the job', rejected.status, 'blocked');
  t.eq('the cause is recorded', (await Q.get(rejected.jobId)).error, 'REVIEW_REJECTED');
  reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };

  // ===== a failing agent fails its job; the tick survives =====
  failAgentOs = true;
  const failRun = await S.runNow('drafter');
  const failJob = await Q.get(failRun.jobId);
  t.ok('provider failure blocks the job with the REAL cause', failJob.status === 'blocked' && failJob.error === 'AI_NOT_CONFIGURED');
  const health = await REG.get('drafter');
  t.ok('failures degrade agent health', health.failures >= 1 && health.health !== 'ok');
  failAgentOs = false;
  const tickSurvives = await S.runDue({ at: '2026-07-07T00:00:00.000Z' });
  t.ok('the next tick still runs every due agent', tickSurvives.ok === true && tickSurvives.ran >= 1);

  // ===== event triggers =====
  const evt = await S.onEvent('lead.created', { id: 'lead_9' });
  t.ok('event trigger runs only subscribed agents', evt.ran === 1 && evt.results[0].agentId === 'drafter');
  t.ok('the event job records its trigger', (await Q.list({ agentId: 'drafter' })).some((j) => j.trigger === 'event:lead.created'));

  // ===== Run now is RBAC-gated =====
  cfg.set({ role: 'crew' });
  t.eq('crew cannot Run now', (await S.runNow('drafter')).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  // ===== missing governance refuses the whole tick =====
  const savedTG = G.AAA_TENANT_GUARD; delete G.AAA_TENANT_GUARD;
  const noGuard = await S.runDue({ at: '2026-07-08T00:00:00.000Z' });
  t.ok('a missing guard refuses the tick by name', noGuard.error === 'GOVERNANCE_MISSING' && noGuard.missing.indexOf('AAA_TENANT_GUARD') !== -1);
  t.eq('Run now is refused the same way', (await S.runNow('drafter')).error, 'GOVERNANCE_MISSING');
  G.AAA_TENANT_GUARD = savedTG;

  // ===== the audit chain holds across everything above =====
  t.ok('audit chain verifies end-to-end', (await G.AAA_AUDIT_LEDGER.verify()).ok === true);

  return t.report();
};
