/* HyperMind Console UI — status, controls, autonomy ledger, tunings + rollback,
 * loop log; owner-only; empty/error states. */
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
function btns(n, acc) { if (!n || typeof n !== 'object') return acc; if (n.tag === 'button') acc.push(n); (n.children || []).forEach((c) => btns(c, acc)); return acc; }

module.exports = async function run() {
  const t = makeRunner('hypermind-ui');
  const { G, cfg, data } = setupEnv();
  load('js/intelligence/hypermind-core.js');
  load('js/ui/hypermind-ui.js');
  G.AAA_UI = fakeUI();
  const UI = G.AAA_HYPERMIND_UI;
  G.AAA_HYPERMIND._reset();

  // executor + calibration ledgers (faked at the data layer the UI reads)
  G.AAA_HYPERMIND_EXECUTOR = {
    history: async () => [{ id: 'a1', mode: 'autonomous', applied: 2, skipped: 1, proposed: 3, at: Date.now() }],
    rollback: async (agent) => { G._rolledBack = agent; return { ok: true }; },
    rollbackAll: async () => { G._rolledAll = true; return { ok: true, reverted: 2 }; }
  };
  G.AAA_CALIBRATION_REGISTRY = {
    versions: async () => [
      { id: 'v1', agent: 'pricing_optimizer', version: 1, active: true, rolledBack: false, autonomous: true, confidenceBias: 5, riskBias: -2, appliedAt: Date.now() },
      { id: 'v2', agent: 'estimator', version: 1, active: true, rolledBack: false, autonomous: true, confidenceBias: -8, riskBias: 4, appliedAt: Date.now() }
    ]
  };
  // a couple of ticks in the loop ledger
  await data.put('hypermind_ticks', 'tk1', { id: 'tk1', status: 'ok', source: 'interval', at: '2026-06-07T10:00:00Z', startedAt: 2, phases: [{ phase: 'observe', status: 'ran' }, { phase: 'execute', status: 'skipped' }] });

  // ===== owner sees the full console =====
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders status section', /Status/.test(dash) && /stopped|running|enabled/.test(dash));
  t.ok('shows advisory/autonomy state', /advisory|autonomous/.test(dash));
  t.ok('renders controls', /Start HyperMind/.test(dash) && /Run one cycle now/.test(dash));
  t.ok('renders autonomous action ledger', /Autonomous Actions/.test(dash) && /2 applied/.test(dash));
  t.ok('renders active tunings with agents', /Active Tunings/.test(dash) && /pricing_optimizer/.test(dash) && /estimator/.test(dash));
  t.ok('offers per-agent + roll-back-all', /Roll back pricing_optimizer/.test(dash) && /Roll back ALL/.test(dash));
  t.ok('renders loop log with phases', /Loop Log/.test(dash) && /observe/.test(dash));
  t.ok('shows the internal-only disclaimer', /never changes a price/i.test(dash));

  // ===== controls are wired =====
  cfg.set({ hypermindEnabled: false });
  const startBtn = btns(c1, []).find((b) => /Start HyperMind/.test(b.opts.label));
  G.setInterval = () => ({ unref() {} }); G.clearInterval = () => {};
  await startBtn.opts.onClick();
  t.ok('Start toggles the master switch', cfg._all().hypermindEnabled === true);

  const rbBtn = btns(c1, []).find((b) => /Roll back pricing_optimizer/.test(b.opts.label));
  await rbBtn.opts.onClick();
  t.eq('per-agent rollback calls the executor', G._rolledBack, 'pricing_optimizer');

  // ===== autonomy toggle / kill switch =====
  cfg.set({ hypermindAutoApply: true });
  const c2 = fakeNode('div', {});
  await UI.render(c2);
  const killBtn = btns(c2, []).find((b) => /kill autonomy/.test(b.opts.label));
  await killBtn.opts.onClick();
  t.ok('autonomy kill switch flips the flag', cfg._all().hypermindAutoApply === false);

  // ===== owner-only lock =====
  G.AAA_RBAC = { can: (p) => p !== 'VIEW_FINANCIALS', role: () => 'crew' };
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  delete G.AAA_RBAC;

  // ===== empty state =====
  const { G: G2, data: d2 } = setupEnv();
  load('js/intelligence/hypermind-core.js');
  load('js/ui/hypermind-ui.js');
  G2.AAA_UI = fakeUI(); G2.AAA_HYPERMIND._reset();
  delete G2.AAA_HYPERMIND_EXECUTOR; delete G2.AAA_CALIBRATION_REGISTRY;
  const cEmpty = fakeNode('div', {});
  await G2.AAA_HYPERMIND_UI.render(cEmpty);
  const emptyT = txt(cEmpty, []).join(' ');
  t.ok('empty state is honest', /No autonomous actions yet/.test(emptyT) && /No calibration applied/.test(emptyT) && /No ticks recorded/.test(emptyT));

  // ===== error state =====
  G2.AAA_HYPERMIND.history = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_HYPERMIND_UI.render(cErr);
  t.ok('error state handled gracefully', /Could not load HyperMind/.test(txt(cErr, []).join(' ')));

  return t.report();
};
