/* Agent Evaluation UI — scorecard list, card detail (CI/FP/FN/ROI), gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/agent-evaluation-lab.js'); load('js/ui/agent-evaluation-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('agent-evaluation-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const UI = G.AAA_AGENT_EVAL_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  G.AAA_PREDICTION_CLOSURE = { closures: async () => [
    { id: 'lf1', agent: 'pricing_optimizer', predictionId: 'd1', status: 'validated' },
    { id: 'lf2', agent: 'pricing_optimizer', predictionId: 'd2', status: 'contradicted' }
  ] };
  await data.put('agent_decisions', 'd1', { id: 'd1', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 80 });
  await data.put('agent_decisions', 'd2', { id: 'd2', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 70 });

  // --- list view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the scorecard list', /Agent scorecards/.test(dash) && /pricing_optimizer/.test(dash) && /accuracy/.test(dash));
  t.ok('offers a snapshot + honest disclaimer', /Snapshot evaluation/.test(dash) && /no fabricated value/.test(dash));

  // --- card detail ---
  const card = await G.AAA_AGENT_EVAL.scorecard('pricing_optimizer');
  const cBody = fakeNode('div', {});
  UI.renderCard(cBody, card);
  const detail = txt(cBody, []).join(' || ');
  t.ok('card shows quality (accuracy + CI + FP/FN)', /Quality/.test(detail) && /Accuracy/.test(detail) && /CI/.test(detail) && /False-positive/.test(detail));
  t.ok('card shows value (revenue/ROI/impact)', /Value/.test(detail) && /Revenue influence/.test(detail) && /cost/.test(detail));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_AGENT_EVAL.scorecards = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_AGENT_EVAL_UI.render(cErr);
  t.ok('error state handled', /Could not load scorecards/.test(txt(cErr, []).join(' ')));

  return t.report();
};
