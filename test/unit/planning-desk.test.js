/* Planning Desk — objective → bounded, validated task graph.
 *
 * Guards the honest contract: malformed graphs are refused with named issues
 * (cycles, unknown dependencies, mutating tasks without rollback/verification),
 * approval phases can only pass with an APPROVED decision envelope (the
 * planner cannot waive the human), execution is dependency-ordered, tenant
 * blocking issues land the plan as 'blocked', and with no model configured
 * plan() returns AI_NOT_CONFIGURED — never a fabricated plan. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function goodGraph() {
  return {
    objective: 'Launch the Germany market for carpet installs',
    assumptions: ['DE country pack is registered'],
    phases: [
      { phase_id: 'discover', name: 'Read current pricing', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales', inputs: [], tools: ['price_book'], verification: [], rollback: [] }] },
      { phase_id: 'gate', name: 'Owner approves DE pricing', mode: 'approval', dependencies: ['discover'], tasks: [{ task_id: 't2', owner_role: 'ceo' }] },
      { phase_id: 'apply', name: 'Write DE price book', mode: 'state_change', dependencies: ['gate'], tasks: [{ task_id: 't3', owner_role: 'accounting', verification: ['re-read price book'], rollback: ['restore previous price book snapshot'] }] },
      { phase_id: 'verify', name: 'Verify quotes render in EUR', mode: 'verification', dependencies: ['apply'], tasks: [{ task_id: 't4', owner_role: 'compliance', verification: ['sample quote in EUR'] }] }
    ],
    blocking_issues: []
  };
}

module.exports = async function run() {
  const t = makeRunner('planning-desk');
  const { G } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/agents/agent-registry.js');
  load('js/agents/planning-desk.js');
  const DESK = G.AAA_PLANNING_DESK, ENV = G.AAA_DECISION_ENVELOPE, LED = G.AAA_AUDIT_LEDGER;

  // ===== honest gating: no executor, no proxy → no fabricated plan =====
  const ungated = await DESK.plan('anything');
  t.eq('without a model, plan() refuses honestly', ungated.error, 'AI_NOT_CONFIGURED');

  // Stub planner (the governed seam, mirroring ephemeral-agent-runtime).
  let nextGraph = goodGraph();
  const seen = [];
  DESK.setExecutor({ name: 'stub', run: async (spec, task, context) => { seen.push({ spec, task, context }); return { ok: true, output: nextGraph }; } });

  // ===== a valid plan persists with per-phase status =====
  const p1 = await DESK.plan('Launch the Germany market', { context: { market: 'DE' } });
  t.ok('plan accepted and persisted', p1.ok === true && !!p1.plan.id);
  t.eq('plan starts active', p1.plan.status, 'active');
  t.eq('four phases pending', p1.plan.phases.filter((p) => p.status === 'pending').length, 4);
  t.ok('planner received the market context', seen[0].context.market === 'DE');
  t.ok('audit trail records plan.created', (await LED.verify()).ok === true);

  // ===== dependency-ordered execution =====
  const r1 = await DESK.runnable(p1.plan.id);
  t.ok('only the root phase is runnable first', r1.phases.length === 1 && r1.phases[0].phaseId === 'discover');
  t.eq('advancing a phase before its deps is refused', (await DESK.advance(p1.plan.id, 'apply')).error, 'DEPENDENCIES_INCOMPLETE');
  t.ok('root phase completes', (await DESK.advance(p1.plan.id, 'discover')).ok === true);

  // ===== the approval gate: only an APPROVED envelope passes =====
  t.eq('approval phase without an envelope is refused', (await DESK.advance(p1.plan.id, 'gate')).error, 'APPROVAL_REQUIRED');
  t.eq('unknown envelope id refused', (await DESK.advance(p1.plan.id, 'gate', { envelopeId: 'nope' })).error, 'ENVELOPE_NOT_FOUND');
  const w = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Adopt DE pricing v1', rationale: 'Margins verified for the market.', confidence: 80, risks: [], next_actions: [] }, impact: { amount: 2000 }, country: 'DE' });
  await ENV.seal(w.envelope);
  t.eq('an UNapproved envelope is refused', (await DESK.advance(p1.plan.id, 'gate', { envelopeId: w.envelope.id })).error, 'ENVELOPE_NOT_APPROVED');
  await ENV.approve(w.envelope.id, { approver: 'aaron' });
  const gated = await DESK.advance(p1.plan.id, 'gate', { envelopeId: w.envelope.id });
  t.ok('an approved envelope passes the gate', gated.ok === true && gated.phase.envelopeId === w.envelope.id);

  // finish the plan
  const done2 = await DESK.advance(p1.plan.id, 'apply');
  const done3 = await DESK.advance(p1.plan.id, 'verify');
  t.ok('remaining phases complete in order', done2.ok === true && done3.ok === true);
  t.eq('plan closes when all phases complete', (await DESK.get(p1.plan.id)).status, 'completed');
  t.eq('double-complete refused', (await DESK.advance(p1.plan.id, 'verify')).error, 'ALREADY_COMPLETED');

  // ===== graph validation refuses the classic failure shapes =====
  nextGraph = goodGraph(); nextGraph.phases[2].tasks[0].rollback = [];
  const noRb = await DESK.plan('x');
  t.ok('state_change without rollback refused by name', noRb.error === 'INVALID_GRAPH' && noRb.issues.some((s) => s.indexOf('requires rollback') !== -1));
  nextGraph = goodGraph(); nextGraph.phases[1].dependencies = ['ghost'];
  const badDep = await DESK.plan('x');
  t.ok('unknown dependency refused', badDep.issues.some((s) => s.indexOf('unknown dependency') !== -1));
  nextGraph = goodGraph(); nextGraph.phases[0].dependencies = ['verify'];
  const cyc = await DESK.plan('x');
  t.ok('dependency cycle refused', cyc.issues.some((s) => s.indexOf('cycle') !== -1));
  nextGraph = goodGraph(); nextGraph.phases[0].tasks[0].owner_role = 'astrologer';
  const badRole = await DESK.plan('x');
  t.ok('unknown owner_role refused (registry-checked)', badRole.issues.some((s) => s.indexOf('astrologer') !== -1));
  nextGraph = goodGraph(); nextGraph.phases[0].mode = 'vibes';
  t.ok('unknown mode refused', (await DESK.plan('x')).issues.some((s) => s.indexOf('mode must be') !== -1));
  nextGraph = { objective: 'x', phases: [{ phase_id: 'a', name: 'a', mode: 'read_only' }, { phase_id: 'a', name: 'dup', mode: 'read_only' }] };
  t.ok('duplicate phase ids refused', (await DESK.plan('x')).issues.some((s) => s.indexOf('duplicate') !== -1));

  // ===== tenant blocking issues land the plan as blocked =====
  nextGraph = goodGraph(); nextGraph.blocking_issues = ['POLICY_BLOCK: objective crosses tenant boundaries'];
  const blocked = await DESK.plan('merge two tenants');
  t.eq('blocking issues → plan is blocked, not active', blocked.plan.status, 'blocked');
  t.eq('a blocked plan cannot run', (await DESK.runnable(blocked.plan.id)).error, 'PLAN_BLOCKED');
  t.eq('a blocked plan cannot advance', (await DESK.advance(blocked.plan.id, 'discover')).error, 'PLAN_BLOCKED');

  // ===== misc honesty =====
  t.eq('empty objective refused', (await DESK.plan('')).error, 'NO_OBJECTIVE');
  t.eq('unknown plan → NOT_FOUND', (await DESK.runnable('nope')).error, 'NOT_FOUND');
  t.ok('list filters by status', (await DESK.list({ status: 'blocked' })).length === 1);
  const thrown = DESK.setExecutor({ name: 'boom', run: async () => { throw new Error('kaput'); } });
  t.ok('executor swap acknowledged', thrown.ok === true);
  const boom = await DESK.plan('x');
  t.ok('a throwing executor is caught, never a crash', boom.ok === false && String(boom.error).indexOf('EXECUTOR_THREW') === 0);
  DESK.setExecutor(null);

  return t.report();
};
