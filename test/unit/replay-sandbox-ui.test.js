/* Replay Sandbox UI — owner panel, trace pick, scenario, result KPI table, links, gates. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  n.addEventListener = function () {};
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  return n;
}
function fakeUI() {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o), spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }), confirm: async () => true
  };
}
function txt(n, acc) { if (!n || typeof n !== 'object') return acc; const o = n.opts || {}; if (o.text) acc.push(String(o.text)); if (o.html) acc.push(String(o.html)); if (o.label) acc.push(String(o.label)); (n.children || []).forEach((c) => txt(c, acc)); return acc; }

function loadAll(G) {
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js'); load('js/intelligence/governance-registry.js');
  load('js/intelligence/calibration-registry.js'); load('js/intelligence/replay-sandbox.js');
  load('js/ui/replay-sandbox-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('replay-sandbox-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const S = G.AAA_REPLAY_SANDBOX;
  const STORE = G.AAA_PROVENANCE;
  const UI = G.AAA_REPLAY_SANDBOX_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // Seed a trace + a calibration version to swap in.
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 20 });
  const trace = await STORE.record({
    subjectType: 'pricing_recommendation', subjectId: 'rec_pb', subjectLabel: 'Low win rate band', agent: 'pricing_optimizer',
    sourceQuotes: [{ quoteId: 'q1', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 20, resolved: true }],
    calibrationVersion: { id: 'calv_inforce', agent: 'pricing_optimizer', version: 1, confidenceBias: 0, riskBias: 0 },
    summary: { decision: 'Review pricing', confidence: 60, risk: 35 }, promptVersion: null, modelVersion: 'deterministic'
  });
  await data.put('calibration_versions', 'calv_hot', { id: 'calv_hot', workspaceId: 'ws_test', agent: 'pricing_optimizer', version: 2, confidenceBias: 15, riskBias: -10, active: true });

  // --- owner sees the sandbox + the trace to replay ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the sandbox header + disclaimer', /Replay Sandbox/.test(dash) && /changes no quote/.test(dash));
  t.ok('lists a trace with a Replay button', /Pick a trace to replay/.test(dash) && /Low win rate band/.test(dash) && /Replay/.test(dash));

  // --- scenario builder lists version choices ---
  const versions = await S.listVersions('pricing_optimizer');
  const sBody = fakeNode('div', {});
  UI.renderScenario(sBody, trace, versions, { calibrationVersionId: null, policyVersionId: null });
  const scen = txt(sBody, []).join(' || ');
  t.ok('scenario shows in-force versions', /in force: calibration v1/.test(scen));
  t.ok('scenario offers a calibration version to swap', /Swap in a calibration version/.test(scen) && /calibration v2/.test(scen) && /Run replay/.test(scen));

  // --- result view: original vs replayed + KPI table + links ---
  const res = await S.replay({ traceId: trace.id, actor: 'owner', scenario: { calibrationVersionId: 'calv_hot' } });
  const rBody = fakeNode('div', {});
  UI.renderResult(rBody, res);
  const out = txt(rBody, []).join(' || ');
  t.ok('shows original vs replayed', /Original vs replayed/.test(out) && /original: /.test(out) && /replayed: /.test(out));
  t.ok('shows the KPI impact table', /KPI impact/.test(out) && /Confidence/.test(out) && /Risk/.test(out) && /Booking likelihood/.test(out));
  t.ok('shows all six required KPI rows', /Price/.test(out) && /Margin floor/.test(out) && /Follow-up SLA/.test(out) && /Review SLA/.test(out));
  t.ok('links back to provenance + governance', /Provenance & governance/.test(out) && new RegExp(trace.id).test(out));
  t.ok('reassures no production write', /no quote, job, customer, outcome, or price was changed/.test(out));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no trace picker', !/Pick a trace to replay/.test(crew));
  RB.setRole('owner');

  // --- empty + error states ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  const cEmpty = fakeNode('div', {});
  await G2.AAA_REPLAY_SANDBOX_UI.render(cEmpty);
  t.ok('empty state is honest', /No recorded traces yet/.test(txt(cEmpty, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3); G3.AAA_RBAC.setRole('owner');
  G3.AAA_PROVENANCE.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_REPLAY_SANDBOX_UI.render(cErr);
  t.ok('error state handled', /Could not load the sandbox/.test(txt(cErr, []).join(' ')));

  return t.report();
};
