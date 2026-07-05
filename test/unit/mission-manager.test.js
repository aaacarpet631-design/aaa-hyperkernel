/* Mission Manager — the Global Agent Manager over the whole hierarchy.
 *
 * Integration-tests the full loop with the REAL planning desk, global desk,
 * decision envelope, review protocol, tenant guard, safety gate, escalation
 * policy, and audit ledger (only the model calls are stubbed): mission →
 * risk → validated plan → department delegation → independent review →
 * human approval gate → completion; plus reroute-on-failure, review-reject
 * blocking, tenant refusal, and honest degradation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('mission-manager');
  const { G } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/core/tenant-guard.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/agents/agent-registry.js');
  load('js/agents/global-desk.js');
  load('js/agents/planning-desk.js');
  load('js/agents/review-protocol.js');
  load('js/agents/mission-manager.js');
  const MM = G.AAA_MISSION_MANAGER, PD = G.AAA_PLANNING_DESK, RP = G.AAA_REVIEW_PROTOCOL;
  const ENV = G.AAA_DECISION_ENVELOPE, LED = G.AAA_AUDIT_LEDGER;

  // ---- stubs at the model seams only -------------------------------------
  let nextGraph = null;
  PD.setExecutor({ name: 'stub-planner', run: async () => ({ ok: true, output: nextGraph }) });
  let reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  RP.setExecutor({ name: 'stub-reviewer', run: async () => ({ ok: true, output: reviewVerdict }) });
  let failRoles = {};
  G.AAA_AGENT_OS = {
    runAgent: async (roleId) => {
      if (failRoles[roleId]) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      return { ok: true, agent: roleId, decisionId: 'dec_x', recommendation: 'Do the task for ' + roleId, rationale: 'Grounded in provided context.', confidence: 82, risks: [], next_actions: [] };
    }
  };

  function fullGraph() {
    return {
      objective: 'Launch DE market', assumptions: [],
      phases: [
        { phase_id: 'discover', name: 'Read pricing', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] },
        { phase_id: 'gate', name: 'Owner sign-off', mode: 'approval', dependencies: ['discover'], tasks: [{ task_id: 't2', owner_role: 'ceo' }] },
        { phase_id: 'apply', name: 'Write price book', mode: 'state_change', dependencies: ['gate'], tasks: [{ task_id: 't3', owner_role: 'accounting', verification: ['re-read'], rollback: ['restore snapshot'] }] },
        { phase_id: 'verify', name: 'Verify EUR quotes', mode: 'verification', dependencies: ['apply'], tasks: [{ task_id: 't4', owner_role: 'compliance' }] }
      ],
      blocking_issues: []
    };
  }

  // ===== risk classification (deterministic, token-free) =====
  t.eq('destructive mission → critical', MM.classifyRisk('drop database and start over').level, 'critical');
  t.eq('external comms mission → high', MM.classifyRisk('send email blast to all customers').level, 'high');
  t.eq('big money mission → high (escalation)', MM.classifyRisk('review the hotel contract', { impact: { amount: 5000 } }).level, 'high');
  t.eq('material money mission → medium', MM.classifyRisk('review pricing table', { impact: { amount: 900 } }).level, 'medium');
  t.eq('benign mission → low', MM.classifyRisk('summarize job notes').level, 'low');

  // ===== tenant boundary: refused before any model runs =====
  const cross = await MM.start('merge pricing from the other franchise', { context: { source: { workspaceId: 'ws_other' } } });
  t.ok('cross-tenant mission refused with the foreign path named', cross.error === 'TENANT_BOUNDARY' && cross.foreign[0].workspaceId === 'ws_other');

  // ===== the full happy path: plan → delegate → review → gate → complete =====
  nextGraph = fullGraph();
  const m1 = await MM.start('Launch the Germany market', { country: 'DE', impact: { amount: 5000 } });
  t.ok('mission starts active with a plan and classified risk', m1.ok === true && m1.mission.status === 'active' && !!m1.mission.planId && m1.mission.risk.level === 'high');

  const s1 = await MM.step(m1.mission.id);
  t.ok('step 1 completes the discovery phase', s1.activity.some((a) => a.phase === 'discover' && a.kind === 'completed'));
  t.ok('the delegated result was independently reviewed', s1.activity.filter((a) => a.kind === 'completed').every((a) => a.reviewed === true));
  t.eq('mission still active', s1.mission.status, 'active');

  const s2 = await MM.step(m1.mission.id);
  t.eq('step 2 pauses at the human gate', s2.mission.status, 'awaiting_approval');
  const pend = s2.mission.pendingApprovals[0];
  t.ok('the gate envelope awaits a human', pend && pend.status === 'awaiting_approval');
  t.eq('the manager cannot pass the gate with an unapproved envelope', (await MM.approvePhase(m1.mission.id, 'gate', pend.envelopeId)).error, 'ENVELOPE_NOT_APPROVED');
  t.ok('stepping again does not duplicate the approval request', (await MM.step(m1.mission.id)).mission.pendingApprovals.length === 1);

  await ENV.approve(pend.envelopeId, { approver: 'aaron' });
  const gatePass = await MM.approvePhase(m1.mission.id, 'gate', pend.envelopeId);
  t.ok('a human-approved envelope passes the gate', gatePass.ok === true && gatePass.mission.status === 'active');

  const s3 = await MM.step(m1.mission.id);
  t.ok('step 3 completes the state change', s3.activity.some((a) => a.phase === 'apply' && a.kind === 'completed'));
  const s4 = await MM.step(m1.mission.id);
  t.eq('mission completes when the plan completes', s4.mission.status, 'completed');
  t.ok('phase results carry the sealed envelopes', Object.keys(s4.mission.phaseResults).length === 4);
  t.ok('the audit chain verifies across the whole mission', (await LED.verify()).ok === true);
  t.eq('a completed mission cannot be stepped', (await MM.step(m1.mission.id)).error, 'MISSION_COMPLETED');

  // ===== reroute: a failed delegation goes through the supervisor ONCE =====
  failRoles = { operations: true };
  nextGraph = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Ops task', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'operations' }] }], blocking_issues: [] };
  const m2 = await MM.start('reschedule the week');
  const s5 = await MM.step(m2.mission.id);
  t.ok('reroute recorded from operations to supervisor', s5.mission.reroutes.length === 1 && s5.mission.reroutes[0].from === 'operations' && s5.mission.reroutes[0].to === 'supervisor');
  t.ok('the rerouted task completed', s5.activity.some((a) => a.kind === 'completed'));
  t.eq('rerouted mission completes', s5.mission.status, 'completed');
  failRoles = {};

  // ===== a hard failure (even the reroute fails) is recorded, not hidden =====
  failRoles = { operations: true, supervisor: true };
  nextGraph = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Ops task', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'operations' }] }], blocking_issues: [] };
  const m3 = await MM.start('reschedule the week again');
  const s6 = await MM.step(m3.mission.id);
  t.ok('hard failure recorded honestly', s6.mission.failures.length === 1 && s6.mission.status === 'needs_revision');
  failRoles = {};

  // ===== the reviewer brake blocks a phase mechanically =====
  reviewVerdict = { decision: 'reject', severity: 'critical', defects: [{ type: 'i18n', description: 'US tax flow proposed for DE', fix_instruction: 'use the DE country pack' }], confidence: 0.95 };
  nextGraph = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Quote flow', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] };
  const m4 = await MM.start('build the DE quote flow', { country: 'DE' });
  const s7 = await MM.step(m4.mission.id);
  t.ok('critical review rejection blocks the phase', s7.activity[0].kind === 'review_rejected' && s7.mission.status === 'needs_revision');
  t.ok('the rejected envelope is actually rejected', (await ENV.list({ status: 'rejected' })).length >= 1);
  reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };

  // ===== planner blocking issues block the mission =====
  nextGraph = fullGraph(); nextGraph.blocking_issues = ['POLICY_BLOCK: crosses tenants'];
  const m5 = await MM.start('merge the tenants');
  t.eq('planner blocking issues → mission blocked', m5.mission.status, 'blocked');
  t.eq('a blocked mission cannot step', (await MM.step(m5.mission.id)).error, 'MISSION_BLOCKED');

  // ===== honest degradation =====
  t.eq('empty mission refused', (await MM.start('')).error, 'NO_MISSION');
  t.eq('unknown mission → NOT_FOUND', (await MM.step('nope')).error, 'NOT_FOUND');
  const savedTG = G.AAA_TENANT_GUARD; delete G.AAA_TENANT_GUARD;
  t.eq('unguarded missions are not allowed', (await MM.start('x')).error, 'TENANT_GUARD_MISSING');
  G.AAA_TENANT_GUARD = savedTG;
  const savedRP = G.AAA_REVIEW_PROTOCOL; delete G.AAA_REVIEW_PROTOCOL;
  nextGraph = fullGraph();
  const m6 = await MM.start('another launch');
  t.eq('unreviewed delegation is not allowed', (await MM.step(m6.mission.id)).error, 'REVIEW_PROTOCOL_MISSING');
  G.AAA_REVIEW_PROTOCOL = savedRP;
  t.ok('list filters by status', (await MM.list({ status: 'completed' })).length === 2);

  return t.report();
};
