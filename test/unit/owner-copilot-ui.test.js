/* Owner Copilot UI — briefing headline, priorities, full sections, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/owner-copilot.js'); load('js/ui/owner-copilot-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('owner-copilot-ui');
  const { G, data } = setupEnv({ fixedISO: '2026-06-07T09:00:00Z' });
  loadAll(G);
  const UI = G.AAA_OWNER_COPILOT_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await data.put('payments', 'p1', { id: 'p1', workspaceId: 'ws_test', amount: 1200, receivedAt: '2026-06-06T10:00:00Z' });
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'sent', customerName: 'Jane', sentAt: '2026-06-01T00:00:00Z', risk: 20 });
  G.AAA_RELIABILITY = { incidents: async () => [{ id: 'inc1', title: 'Transport failure critical', severity: 'crit' }] };
  G.AAA_PROPOSAL_ENGINE = { list: async () => [{ id: 'prop1', title: 'Follow up faster', status: 'pending' }] };

  // --- owner briefing ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the morning headline + date', /Good morning/.test(dash) && /2026-06-07/.test(dash));
  t.ok('renders the attention summary', /Need you/.test(dash) && /Rev\. yesterday/.test(dash) && /Critical/.test(dash));
  t.ok('renders "what needs you today" with the critical item', /What needs you today/.test(dash) && /Transport failure critical/.test(dash));
  t.ok('renders the full briefing sections', /Full briefing/.test(dash) && /Follow-ups due/.test(dash) && /Learning proposals to review/.test(dash) && /Critical operational issues/.test(dash));
  t.ok('shows the read-only disclaimer', /surfaces decisions, it makes none/.test(dash) || /surfaces/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_OWNER_COPILOT.briefing = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_OWNER_COPILOT_UI.render(cErr);
  t.ok('error state handled', /Could not load the briefing/.test(txt(cErr, []).join(' ')));

  return t.report();
};
