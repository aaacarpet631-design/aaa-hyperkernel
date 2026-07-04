/* Approval Inbox UI — one screen where the OWNER unblocks the machine.
 *
 * Guards the honest contract: the read model lists awaiting envelopes (with
 * paused reasons, localized impact, review verdicts, tenant) and paused
 * mission gates; approve is role-gated in the UI AND again in the engine;
 * reject stays available to any role (the brake); approveGate passes a real
 * mission gate end-to-end; markup escapes all dynamic values; missing DOM
 * and empty states degrade honestly. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('approval-inbox-ui');
  const { G, cfg } = setupEnv();
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
  load('js/ui/approval-inbox-ui.js');
  const UI = G.AAA_APPROVAL_INBOX_UI, ENV = G.AAA_DECISION_ENVELOPE;
  const MM = G.AAA_MISSION_MANAGER, PD = G.AAA_PLANNING_DESK, RP = G.AAA_REVIEW_PROTOCOL;

  // ===== empty state =====
  const empty = await UI.renderModel();
  t.ok('empty inbox is honest', empty.counts.envelopes === 0 && empty.counts.gates === 0 && empty.canApprove === true);

  // ===== an awaiting envelope with a review verdict =====
  const w1 = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Send the <script>alert(1)</script> quote', rationale: 'r', confidence: 40, risks: [], next_actions: [] }, impact: { amount: 1200 }, country: 'DE' });
  await ENV.seal(w1.envelope);
  RP.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { decision: 'needs_revision', severity: 'medium', defects: [{ type: 'i18n', description: 'd', fix_instruction: 'f' }], confidence: 0.7 } }) });
  await RP.reviewEnvelope(w1.envelope.id);

  // ===== a mission paused at a gate =====
  PD.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { objective: 'x', phases: [{ phase_id: 'gate', name: 'Sign-off', mode: 'approval', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'ceo' }] }], blocking_issues: [] } }) });
  G.AAA_AGENT_OS = { runAgent: async (roleId) => ({ ok: true, agent: roleId, decisionId: 'd1', recommendation: 'Approve going ahead', rationale: 'r', confidence: 82, risks: [], next_actions: [] }) };
  const m1 = await MM.start('gate-only mission', { impact: { amount: 5000 } });
  await MM.step(m1.mission.id);

  const model = await UI.renderModel();
  t.eq('awaiting envelopes listed', model.counts.envelopes, 2); // w1 + the gate's own envelope
  t.eq('paused gates listed', model.counts.gates, 1);
  const row = model.envelopes.filter((e) => e.envelopeId === w1.envelope.id)[0];
  t.ok('envelope row carries decide-able context', row && row.agent === 'sales' && row.country === 'DE' && row.tenant === 'ws_test' && row.confidence === 40);
  t.ok('impact is localized for the owner', /€|EUR/.test(String(row.impact)));
  t.ok('paused reasons are surfaced', row.pausedReasons.length >= 1);
  t.ok('review verdicts attached', row.reviews.length === 1 && row.reviews[0].decision === 'needs_revision');
  const gate = model.gates[0];
  t.ok('gate row names mission, phase, risk', gate.missionId === m1.mission.id && gate.phaseId === 'gate' && gate.risk === 'high');

  // ===== markup escapes dynamic values =====
  const html = UI.envelopeRowHtml(row);
  t.ok('recommendation is escaped in markup', html.indexOf('<script>') === -1 && html.indexOf('&lt;script&gt;') !== -1);

  // ===== role gating: crew cannot approve, CAN reject =====
  cfg.set({ role: 'crew' });
  const crewModel = await UI.renderModel();
  t.eq('crew sees read-only', crewModel.canApprove, false);
  t.eq('crew approve refused in the UI', (await UI.approve(w1.envelope.id)).error, 'FORBIDDEN');
  t.eq('crew approveGate refused', (await UI.approveGate(m1.mission.id, 'gate', 'any')).error, 'FORBIDDEN');
  const crewReject = await UI.reject(w1.envelope.id, { reason: 'wrong market flow' });
  t.ok('crew CAN pull the brake (reject)', crewReject.ok === true && crewReject.envelope.approval.status === 'rejected');
  cfg.set({ role: 'owner' });

  // ===== owner approves the gate end-to-end =====
  const pend = (await MM.get(m1.mission.id)).pendingApprovals[0];
  const gatePass = await UI.approveGate(m1.mission.id, 'gate', pend.envelopeId, { approver: 'aaron' });
  t.ok('owner approveGate passes the mission gate', gatePass.ok === true && gatePass.mission.status === 'completed');
  t.eq('the gate envelope is approved', (await ENV.get(pend.envelopeId)).approval.status, 'approved');

  // ===== honest degradation =====
  t.eq('mount without DOM refuses', (await UI.mount()).error, 'NO_DOM');
  const savedEnv = G.AAA_DECISION_ENVELOPE; delete G.AAA_DECISION_ENVELOPE;
  t.eq('approve without the engine refuses', (await UI.approve('x')).error, 'ENVELOPE_MODULE_MISSING');
  const degraded = await UI.renderModel();
  t.ok('missing engine degrades to an empty section, no throw', degraded.counts.envelopes === 0);
  G.AAA_DECISION_ENVELOPE = savedEnv;

  return t.report();
};
