/* Supervisor Council UI — leaderboard/convene/meeting render; owner-only; empty/error. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js'); load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/agent-council.js'); load('js/ui/agent-council-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('agent-council-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const C = G.AAA_AGENT_COUNCIL;
  const UI = G.AAA_AGENT_COUNCIL_UI;
  const RB = G.AAA_RBAC;

  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'reviewed', customerName: 'Jane', confidence: 80, risk: 20, marginPct: 30, leadSource: 'referral', serviceType: ['carpet_install'], jobId: 'j1' });
  const conv = await C.conveneOnQuote('q1');

  // --- owner sees leaderboard + convene + recent meetings ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the agent leaderboard', /Agent Leaderboard/.test(dash) && /Estimator/.test(dash) && /Finance/.test(dash));
  t.ok('renders convene-on-quote', /Convene on a quote/.test(dash) && /Convene council/.test(dash) && /Jane/.test(dash));
  t.ok('renders recent meetings', /Recent Meetings/.test(dash));
  t.ok('shows the advisory disclaimer', /council recommends; you decide/i.test(dash));

  // --- meeting view: positions + tally + owner controls ---
  const cM = fakeNode('div', {});
  UI.renderMeeting(cM, await C.get(conv.session.id));
  const meeting = txt(cM, []).join(' || ');
  t.ok('shows the table of positions', /Around the table/.test(meeting) && /Estimator/.test(meeting) && /Finance/.test(meeting));
  t.ok('shows confidence + disagreement', /Confidence/.test(meeting) && /Disagreement/.test(meeting) && /Weighted tally/.test(meeting));
  t.ok('offers owner accept + override controls', /Your decision/.test(meeting) && /Accept \(/.test(meeting) && /Override →/.test(meeting));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no leaderboard', !/Agent Leaderboard/.test(crew));
  RB.setRole('owner');

  // --- empty + error states ---
  const { G: G2 } = setupEnv(); loadAll(G2);
  const cEmpty = fakeNode('div', {});
  await G2.AAA_AGENT_COUNCIL_UI.render(cEmpty);
  t.ok('empty state is honest', /No council meetings yet/.test(txt(cEmpty, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3);
  G3.AAA_AGENT_COUNCIL.leaderboard = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_AGENT_COUNCIL_UI.render(cErr);
  t.ok('error state handled', /Could not load the council/.test(txt(cErr, []).join(' ')));

  return t.report();
};
