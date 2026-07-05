/* Workforce UI — the Agent Workforce Command Center.
 *
 * Guards the honest contract: the read model shows every agent with status,
 * health, schedule, failures, cost, last job, and approvals waiting — with
 * the kill-switch state stated plainly (visibility without execution);
 * toggle/run/tick are role-gated in the UI AND enforced again below; Run
 * now from the UI goes through the full governed scheduler path; the job
 * log is inspectable per agent; markup escapes dynamic values; missing
 * DOM/engines degrade honestly. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function makeHost() {
  const attrs = {};
  return {
    innerHTML: '', _listeners: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener(type, fn) { this._listeners[type] = fn; }
  };
}
function makeBtnTarget(data) {
  return { closest: () => ({ getAttribute: (k) => (data[k.replace('data-', '')] != null ? data[k.replace('data-', '')] : null) }) };
}

module.exports = async function run() {
  const t = makeRunner('workforce-ui');
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
  load('js/ui/workforce-ui.js');
  const UI = G.AAA_WORKFORCE_UI, REG = G.AAA_WORKFORCE_REGISTRY;

  G.AAA_AGENT_OS = { runAgent: async (roleId) => ({ ok: true, agent: roleId, decisionId: 'd', recommendation: 'draft', rationale: 'r', confidence: 82, risks: [], next_actions: [] }) };
  G.AAA_PLANNING_DESK.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { objective: 'x', phases: [{ phase_id: 'p1', name: 'Draft', mode: 'read_only', dependencies: [], tasks: [{ task_id: 't1', owner_role: 'sales' }] }], blocking_issues: [] } }) });
  G.AAA_REVIEW_PROTOCOL.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 } }) });

  // ===== model: defaults + kill switch stated plainly =====
  await REG.seedDefaults();
  const m0 = await UI.renderModel();
  t.eq('five default agents visible', m0.agents.length, 5);
  t.ok('kill switch state is shown honestly (OFF)', m0.continuousEnabled === false && m0.counts.enabled === 0);
  t.ok('rows carry decide-able detail', m0.agents.every((a) => a.name && a.department && a.cadence && a.riskCeiling && a.health));

  // ===== toggle + run via the shared act() path =====
  const tog = await UI.act('toggle', { agentId: 'lead_watcher' });
  t.ok('toggle enables the agent', tog.ok === true && tog.agent.enabled === true);
  const ran = await UI.act('run', { agentId: 'lead_watcher' });
  t.ok('Run now from the UI goes through the governed scheduler', ran.ok === true && ran.status === 'completed' && !!ran.missionId);
  const m1 = await UI.renderModel();
  const lw = m1.agents.filter((a) => a.id === 'lead_watcher')[0];
  t.ok('the run is visible in the panel', lw.runs === 1 && lw.lastJob && lw.lastJob.status === 'completed' && lw.lastRunAt != null);
  t.eq('a disabled agent refuses Run now through the same path', (await UI.act('run', { agentId: 'repo_watcher' })).error, 'AGENT_DISABLED');

  // ===== the job log is inspectable =====
  await UI.act('log', { agentId: 'lead_watcher' });
  const m2 = await UI.renderModel();
  t.ok('log expands with the agent jobs', m2.agents.filter((a) => a.id === 'lead_watcher')[0].log.length === 1);
  await UI.act('log', { agentId: 'lead_watcher' }); // collapse

  // ===== role gating: crew is read-only =====
  cfg.set({ role: 'crew' });
  const crew = await UI.renderModel();
  t.eq('crew sees read-only', crew.canManage, false);
  t.eq('crew toggle refused', (await UI.act('toggle', { agentId: 'lead_watcher' })).error, 'FORBIDDEN');
  t.eq('crew run refused (scheduler RBAC)', (await UI.act('run', { agentId: 'lead_watcher' })).error, 'FORBIDDEN');
  t.eq('crew tick refused', (await UI.act('tick', {})).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  // ===== markup: escaping + permission gating =====
  const row = (await UI.renderModel()).agents[0];
  row.name = '<script>x</script>';
  const html = UI.agentRowHtml(row, { canManage: true });
  t.ok('markup escapes dynamic values', html.indexOf('<script>') === -1 && html.indexOf('&lt;script&gt;') !== -1);
  t.ok('manager markup has run/toggle controls', html.indexOf('data-act="run"') !== -1 && html.indexOf('data-act="toggle"') !== -1);
  const roHtml = UI.agentRowHtml(row, { canManage: false });
  t.ok('read-only markup drops the controls, keeps the log', roHtml.indexOf('data-act="run"') === -1 && roHtml.indexOf('data-act="log"') !== -1);

  // ===== mount + delegated clicks =====
  G.document = { getElementById: () => null };
  const host = makeHost();
  const mounted = await UI.mount(host);
  t.ok('mount(el) renders the panel', mounted.ok === true && host.innerHTML.indexOf('Agent Workforce') !== -1);
  t.ok('kill-switch OFF note rendered', host.innerHTML.indexOf('kill switch') !== -1);
  t.ok('one delegated listener wired', typeof host._listeners.click === 'function' && host._wfWired === true);
  const clickRes = await UI._onClick(makeBtnTarget({ act: 'toggle', agent: 'repo_watcher' }), host);
  t.ok('a click toggles through the same act() path', clickRes.ok === true && clickRes.agent.enabled === true);
  t.ok('the panel re-rendered live state', host.innerHTML.indexOf('(2 on duty)') !== -1);
  cfg.set({ role: 'crew' });
  await UI._onClick(makeBtnTarget({ act: 'toggle', agent: 'repo_watcher' }), host);
  t.ok('a refused click renders the honest note', host.innerHTML.indexOf('cannot manage agents') !== -1);
  cfg.set({ role: 'owner' });
  t.eq('non-button clicks are no-ops', await UI._onClick({ closest: () => null }, host), null);
  delete G.document;

  // ===== honest degradation =====
  t.eq('mount without DOM refuses', (await UI.mount()).error, 'NO_DOM');
  t.eq('open without the UI kit refuses', UI.open().error, 'NO_DOM');
  t.eq('unknown action refused', (await UI.act('yolo', {})).error, 'UNKNOWN_ACTION');
  const savedReg = G.AAA_WORKFORCE_REGISTRY; delete G.AAA_WORKFORCE_REGISTRY;
  t.ok('missing registry degrades to an empty model, no throw', (await UI.renderModel()).agents.length === 0);
  G.AAA_WORKFORCE_REGISTRY = savedReg;

  return t.report();
};
