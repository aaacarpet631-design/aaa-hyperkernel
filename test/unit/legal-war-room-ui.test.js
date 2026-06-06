/* Legal War Room — renders the read-only legal posture; crew denied VIEW_LEGAL. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  n.addEventListener = function () {};
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  return n;
}
function fakeUI(sheets) {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o), spinner: (text) => fakeNode('spinner', { text: text }),
    statusBadge: (o) => fakeNode('badge', typeof o === 'object' ? o : { text: o }),
    sheet: (o) => { const s = { overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }; sheets.push(s); return s; },
    confirm: async () => true
  };
}
function txt(n, acc) { if (!n || typeof n !== 'object') return acc; const o = n.opts || {}; if (o.text) acc.push(String(o.text)); if (o.html) acc.push(String(o.html)); (n.children || []).forEach((c) => txt(c, acc)); return acc; }

module.exports = async function run() {
  const t = makeRunner('legal-war-room-ui');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/legal/legal-store.js');
  load('js/legal/legal-risk-engine.js');
  load('js/ui/legal-war-room-ui.js');
  const sheets = [];
  G.AAA_UI = fakeUI(sheets);
  G.document = { body: fakeNode('body', {}) };  // for open()'s overlay mount
  const WR = G.AAA_LEGAL_WAR_ROOM;
  const RB = G.AAA_RBAC;

  // Seed some legal posture.
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', currentState: 'IN_PROGRESS' });
  RB.setRole('owner');
  await G.AAA_LEGAL_STORE.add('incident', { detail: 'claim' }, { author: 'owner', title: 'Incident', links: { jobId: 'j1' }, status: 'open' });

  // --- render the war room (owner) ---
  const body = fakeNode('div', {});
  await WR.render(body);
  const out = txt(body, []).join(' || ');
  t.ok('war room renders content', body.children.length > 0);
  t.ok('shows the scan summary', /Scanned \d+ job/.test(out));

  // --- crew is denied VIEW_LEGAL on open() ---
  RB.setRole('crew');
  await WR.open();
  const last = sheets[sheets.length - 1];
  const lastText = txt(last.body, []).join(' || ');
  t.ok('crew sees the legal access denial', /cannot view the Legal War Room/i.test(lastText));
  RB.setRole('owner');

  return t.report();
};
