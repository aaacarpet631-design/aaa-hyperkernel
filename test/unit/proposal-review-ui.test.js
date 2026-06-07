/* Proposal Review UI — list, detail (evidence/links/rollback), approve/reject controls, gates. */
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
  load('js/intelligence/proposal-engine.js'); load('js/ui/proposal-review-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('proposal-review-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const E = G.AAA_PROPOSAL_ENGINE;
  const UI = G.AAA_PROPOSAL_REVIEW_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  let i = 0; const q = (status, days) => { i++; return data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', status: status, marginPct: status === 'won' ? 30 : 0, customerTotal: 1500, sentAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-01-0' + (1 + days) + 'T00:00:00Z' }); };
  for (let k = 0; k < 5; k++) await q('won', 1);
  for (let k = 0; k < 5; k++) await q('lost', 6);
  await E.generate();
  const p = (await E.list())[0];

  // --- owner list view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the proposal summary', /Pending/.test(dash) && /Rejected \(learning\)/.test(dash));
  t.ok('lists a discovered proposal', /closes \d+% more/.test(dash) && /Discover new proposals/.test(dash));
  t.ok('shows the governance disclaimer', /nothing reaches production automatically/.test(dash));

  // --- detail: evidence, links, rollback, owner controls ---
  const dBody = fakeNode('div', {});
  UI.renderProposal(dBody, await E.get(p.id));
  const detail = txt(dBody, []).join(' || ');
  t.ok('shows what it proposes (governed change)', /What it proposes/.test(detail) && /policy/.test(detail) && /followUpDays/.test(detail));
  t.ok('shows KPI impact + affected systems + rollback', /Affects/.test(detail) && /Rollback/.test(detail));
  t.ok('shows evidence + links', /Evidence & links/.test(detail) && /provenance trace/.test(detail));
  t.ok('offers simulate + approve + reject', /Simulate/.test(detail) && /Approve → governance/.test(detail) && /Reject/.test(detail));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_PROPOSAL_ENGINE.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_PROPOSAL_REVIEW_UI.render(cErr);
  t.ok('error state handled', /Could not load proposals/.test(txt(cErr, []).join(' ')));

  return t.report();
};
