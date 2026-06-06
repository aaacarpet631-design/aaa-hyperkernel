/* Event Stream UI — catalog, log, chain integrity, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-events.js'); load('js/core/aaa-event-bus.js');
  load('js/ui/event-stream-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('event-stream-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const BUS = G.AAA_EVENT_BUS;
  const UI = G.AAA_EVENT_STREAM_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await BUS.publish('quote.created', { quoteId: 'q1', customerId: 'c1', total: 500 });
  await BUS.publish('job.closed', { jobId: 'j1', outcome: 'won' });

  // --- owner view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the summary', /Events/.test(dash) && /Contracts/.test(dash) && /Chain/.test(dash));
  t.ok('shows chain integrity intact', /Chain integrity/.test(dash) && /Intact/.test(dash));
  t.ok('lists the contract catalog', /Event contracts/.test(dash) && /quote\.created/.test(dash));
  t.ok('lists recent events', /Recent events/.test(dash) && /job\.closed/.test(dash));
  t.ok('shows the ownership note', /AAA owns the event contracts/.test(dash));

  // --- tamper surfaces ---
  const log = await BUS.log();
  const v = log[log.length - 1];
  await data.put('event_log', v.id, Object.assign({}, v, { payload: { quoteId: 'HACKED' } }));
  const c2 = fakeNode('div', {});
  await UI.render(c2);
  t.ok('UI surfaces a detected tamper', /break\(s\)/.test(txt(c2, []).join(' ')));
  await data.put('event_log', v.id, v);

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_EVENT_BUS.log = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_EVENT_STREAM_UI.render(cErr);
  t.ok('error state handled', /Could not load the event stream/.test(txt(cErr, []).join(' ')));

  return t.report();
};
