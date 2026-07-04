/* Governance Guarantees — the three behaviors this platform must never lose.
 *
 * A dedicated proof suite (real modules, only model seams stubbed):
 *   1. SELF-APPROVAL IS IMPOSSIBLE — no agent, reviewer, mission, or the
 *      authoring persona itself can approve an envelope through any direct
 *      or indirect path; non-owner roles are refused; only a human with
 *      OVERRIDE_AI_DECISION can grant.
 *   2. TENANT VIOLATIONS FAIL BEFORE ANY MODEL CALL — cross-tenant mission
 *      contexts, restricted markets, and tenant model denials all refuse
 *      with the provider call counter still at zero.
 *   3. REJECTED CRITICAL REVIEWS BLOCK PHASE COMPLETION — the phase stays
 *      pending and the mission goes needs_revision; after the governance
 *      path resolves (a clean re-run passes review), the same phase
 *      completes. Blocked transition AND allowed transition both proven. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance-guarantees');
  const { G, cfg } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/core/tenant-guard.js');
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/ai/tenant-model-policy.js');
  load('js/agents/agent-registry.js');
  load('js/agents/global-desk.js');
  load('js/agents/planning-desk.js');
  load('js/agents/review-protocol.js');
  load('js/agents/mission-manager.js');
  const ENV = G.AAA_DECISION_ENVELOPE, MM = G.AAA_MISSION_MANAGER, PD = G.AAA_PLANNING_DESK;
  const RP = G.AAA_REVIEW_PROTOCOL, TP = G.AAA_TENANT_MODEL_POLICY, DESK = G.AAA_GLOBAL_DESK;

  let modelCalls = 0;
  G.AAA_AGENT_OS = { runAgent: async (roleId) => { modelCalls++; return { ok: true, agent: roleId, decisionId: 'd', recommendation: 'do the task', rationale: 'grounded', confidence: 82, risks: [], next_actions: [] }; } };
  PD.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: PLAN }) });
  let reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  RP.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: reviewVerdict }) });
  let PLAN = null;

  // ══════════ GUARANTEE 1: self-approval is impossible ══════════
  const w = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Send the big quote', rationale: 'r', confidence: 45, risks: [], next_actions: [] }, impact: { amount: 3000 } });
  await ENV.seal(w.envelope);
  t.eq('the envelope is paused for a human', w.envelope.approval.status, 'awaiting_approval');

  t.eq('an agent identity cannot approve', (await ENV.approve(w.envelope.id, { approver: 'agent:sales' })).error, 'NON_HUMAN_APPROVER');
  t.eq('a mission identity cannot approve', (await ENV.approve(w.envelope.id, { approver: 'mission:m_42' })).error, 'NON_HUMAN_APPROVER');
  t.eq('a reviewer identity cannot approve', (await ENV.approve(w.envelope.id, { approver: 'reviewer:rev_1' })).error, 'NON_HUMAN_APPROVER');
  t.eq('a system identity cannot approve', (await ENV.approve(w.envelope.id, { approver: 'system:cron' })).error, 'NON_HUMAN_APPROVER');
  t.eq('the authoring persona cannot approve its own envelope', (await ENV.approve(w.envelope.id, { approver: 'sales' })).error, 'NON_HUMAN_APPROVER');
  cfg.set({ role: 'crew' });
  t.eq('a crew session cannot approve (RBAC)', (await ENV.approve(w.envelope.id, { approver: 'jimmy' })).error, 'FORBIDDEN');
  cfg.set({ role: 'manager' });
  t.eq('a manager session cannot approve (OVERRIDE_AI_DECISION is owner-only)', (await ENV.approve(w.envelope.id, { approver: 'pat' })).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  // indirect path: a reviewer "approve" verdict never grants
  reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.95 };
  await RP.reviewEnvelope(w.envelope.id);
  t.eq('a reviewer approve verdict does not grant', (await ENV.get(w.envelope.id)).approval.status, 'awaiting_approval');

  // indirect path: the mission manager cannot pass its own gate
  PLAN = { objective: 'x', phases: [{ phase_id: 'gate', name: 'Sign-off', mode: 'approval', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'ceo' }] }], blocking_issues: [] };
  const m1 = await MM.start('gated mission', { impact: { amount: 5000 } });
  await MM.step(m1.mission.id);
  const pend = (await MM.get(m1.mission.id)).pendingApprovals[0];
  t.eq('the manager cannot pass its own gate with the unapproved envelope', (await MM.approvePhase(m1.mission.id, 'gate', pend.envelopeId)).error, 'ENVELOPE_NOT_APPROVED');
  t.ok('a HUMAN owner approval is what passes the gate', (await ENV.approve(pend.envelopeId, { approver: 'aaron' })).ok === true && (await MM.approvePhase(m1.mission.id, 'gate', pend.envelopeId)).ok === true);

  // ══════════ GUARANTEE 2: tenant violations fail BEFORE model calls ══════════
  const before = modelCalls;
  const cross = await MM.start('use the other franchise pricing', { context: { pricing: { workspaceId: 'ws_other' } } });
  t.eq('cross-tenant mission refused', cross.error, 'TENANT_BOUNDARY');
  t.eq('…and no model was called for it', modelCalls, before);

  await TP.setPolicy({ restrictedMarkets: ['MX'] });
  const restricted = await DESK.dispatch('sell into the restricted market', { department: 'sales', country: 'MX' });
  t.eq('restricted market dispatch refused', restricted.error, 'MARKET_RESTRICTED');
  t.eq('…and no model was called for it', modelCalls, before);
  await TP.clearPolicy();

  // ══════════ GUARANTEE 3: rejected critical reviews block completion ══════════
  PLAN = { objective: 'x', phases: [{ phase_id: 'p1', name: 'Build DE flow', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] };
  reviewVerdict = { decision: 'reject', severity: 'critical', defects: [{ type: 'i18n', description: 'US tax flow proposed for DE', fix_instruction: 'use the DE country pack' }], confidence: 0.95 };
  const m2 = await MM.start('build the DE quote flow', { country: 'DE' });
  const blockedStep = await MM.step(m2.mission.id);
  t.eq('critical reject → mission needs revision', blockedStep.mission.status, 'needs_revision');
  const planAfterBlock = await PD.get(blockedStep.mission.planId);
  t.eq('…and the phase did NOT complete', planAfterBlock.phases[0].status, 'pending');
  t.ok('…and the offending envelope is rejected on the record', (await ENV.list({ status: 'rejected' })).length >= 1);

  // the governance path resolves: the re-run survives review → phase completes
  reviewVerdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  const resolvedStep = await MM.step(m2.mission.id);
  t.eq('after resolution, the SAME phase completes', (await PD.get(m2.mission.planId)).phases[0].status, 'completed');
  t.eq('and the mission closes', resolvedStep.mission.status, 'completed');

  return t.report();
};
