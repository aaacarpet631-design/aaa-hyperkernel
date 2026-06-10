/* Decision Bundle UI — the "Approve All" sheet (Stage 2 compression).
 *
 * Guards the regression that motivated the card sheet: AAA_UI.sheet() returns
 * { overlay, body, close } and the CALLER must append the overlay to
 * document.body or the sheet is invisible on a real phone while every Node
 * suite stays green. Also guards: hero line (count · total · avg confidence),
 * a scannable member list with NO phone number in the DOM, esc() on hostile
 * names, Approve All → AAA_DECISION_INBOX.approveBundle (dry-run only) →
 * close on success / stay open on failure, Cancel → close without approving,
 * and the no-DOM / no-kit / no-bundle guards. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (same shape the decision-card suite uses) -------------
function makeEl() {
  const e = {
    _text: '', style: {}, className: '', value: '', children: [], innerHTML: '',
    disabled: false, type: '',
    classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; }, toggle(c, on) { const v = on === undefined ? !this._s[c] : !!on; if (v) this._s[c] = true; else delete this._s[c]; return v; } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { e.children.push(c); return c; },
    insertBefore(c) { e.children.unshift(c); return c; },
    removeChild(c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); return c; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}
  };
  Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = v; } });
  Object.defineProperty(e, 'firstChild', { get() { return e.children[0] || null; } });
  Object.defineProperty(e, 'parentNode', { get() { return null; } });
  return e;
}
function installDom() {
  const byId = {};
  global.document = {
    createElement: () => makeEl(),
    getElementById: (id) => (byId[id] || (byId[id] = makeEl())),
    body: makeEl(),
    _byId: byId
  };
  return global.document;
}

// ---- tree helpers ------------------------------------------------------------
function walk(n, fn) { if (!n) return; fn(n); (n.children || []).forEach((c) => walk(c, fn)); }
function htmlOf(root) { let h = ''; walk(root, (n) => { if (n.innerHTML) h += n.innerHTML; if (n._text) h += n._text; }); return h; }
function findByClass(root, cls) { let f = null; walk(root, (n) => { if (!f && String(n.className || '').indexOf(cls) !== -1) f = n; }); return f; }

// schema-v1.0 card factory (shape matches decision-inbox.js exactly)
function makeCard(id, name, ev, conf) {
  return {
    decisionId: id, schemaVersion: '1.0',
    trigger: { event: 'quote.follow_up_due', timestamp: '2026-06-10T12:00:00Z', payload: { quoteId: 'q_' + id, customerId: null, customerName: name, recommendedActionId: 'call_now' } },
    agent: 'SalesDirectorAI',
    proposal: {
      actionType: 'SEND_COMMUNICATION', channel: 'SMS', templateId: 'followup_sms_v1',
      metrics: { expectedValueUSD: ev, confidenceScore: conf, rationale: 'Company win rate ' + Math.round(conf * 100) + '%' },
      payload: { recipient: '+1 (702) 555-0192', body: 'Hi ' + name + ' — just checking in.' }
    },
    governance: { status: 'AWAITING_APPROVAL', policy: 'MANUAL_REVIEW_REQUIRED' }
  };
}
// a listBundles()-shaped bundle, hostile member name included
function makeBundle(over) {
  return Object.assign({
    id: 'bundle_revenue_recovery', key: 'revenue_recovery', label: 'Revenue Recovery',
    decisions: [
      makeCard('dec_1', 'Marina Bay', 1000, 0.5),
      makeCard('dec_2', 'Henderson', 300, 0.4),
      makeCard('dec_3', '<script>alert(1)</script>', 200, 0.5)
    ],
    count: 3, totalImpactUSD: 1500, avgConfidencePct: 47
  }, over || {});
}

module.exports = async function run() {
  const t = makeRunner('decision-bundle-ui');
  const { G } = setupEnv();
  try {
    load('js/ui/decision-bundle-ui.js');
    const BUNDLE = G.AAA_DECISION_BUNDLE;

    // ===== guards ==============================================================
    delete global.document;
    const noDom = BUNDLE.open(makeBundle());
    t.ok('open() without a document → { opened:false, reason:"no_dom" }',
      noDom.opened === false && noDom.reason === 'no_dom');

    installDom();
    delete G.AAA_UI;
    const noKit = BUNDLE.open(makeBundle());
    t.ok('open() without AAA_UI → { opened:false, reason:"no_ui_kit" }',
      noKit.opened === false && noKit.reason === 'no_ui_kit');

    let closed = 0;
    G.AAA_UI = { sheet: () => ({ overlay: makeEl(), body: makeEl(), close: () => { closed++; } }) };
    t.ok('open() with a null / empty / decision-less bundle → no_bundle',
      BUNDLE.open(null).reason === 'no_bundle' && BUNDLE.open({}).reason === 'no_bundle' &&
      BUNDLE.open({ decisions: [] }).reason === 'no_bundle');

    // ===== stubs: tracked approveBundle ========================================
    const calls = [];
    let approveResult = { ok: true, dryRun: true, dispatched: false, total: 3, approved: 2, blocked: 1, results: [] };
    let labelDuring = null, btnRef = null;
    G.AAA_DECISION_INBOX = { approveBundle: async (bundle, opts) => { calls.push({ bundle, opts }); if (btnRef) labelDuring = btnRef._text; return approveResult; } };

    // ===== open + render =======================================================
    const bundle = makeBundle();
    const approved = [];
    const r = BUNDLE.open(bundle, { onApprove: (res) => approved.push(res) });
    t.ok('open() returns { opened:true, sheet }', r.opened === true && !!r.sheet);
    t.ok('THE REGRESSION GUARD: overlay is APPENDED to document.body',
      global.document.body.children.indexOf(r.sheet.overlay) !== -1);
    const html = htmlOf(r.sheet.body);
    t.ok('hero renders "{count} actions · +$total potential · NN% avg confidence"',
      html.indexOf('3 actions') !== -1 && html.indexOf('+$1,500 potential') !== -1 &&
      html.indexOf('47% avg confidence') !== -1);
    t.ok('scannable member list renders customer · $EV · NN%',
      html.indexOf('Marina Bay') !== -1 && html.indexOf('$1,000 · 50%') !== -1 &&
      html.indexOf('Henderson') !== -1 && html.indexOf('$300 · 40%') !== -1);
    t.ok('NO phone number reaches the DOM, and the hostile member name is escaped',
      html.indexOf('555-0192') === -1 && html.indexOf('(702)') === -1 && html.indexOf('0192') === -1 &&
      html.indexOf('&lt;script&gt;') !== -1 && html.indexOf('<script>') === -1);

    // ===== Approve All → approveBundle → success closes ========================
    const approveBtn = findByClass(r.sheet.body, 'db-btn--approve');
    const cancelBtn = findByClass(r.sheet.body, 'db-btn--cancel');
    t.ok('ONE big "Approve All (3)" primary + a "Cancel" ghost rendered',
      !!approveBtn && approveBtn._text === 'Approve All (3)' && !!cancelBtn && cancelBtn._text === 'Cancel');
    btnRef = approveBtn;
    await approveBtn.onclick();
    t.ok('Approve All calls AAA_DECISION_INBOX.approveBundle with THE bundle (no live flag)',
      calls.length === 1 && calls[0].bundle === bundle && !(calls[0].opts && calls[0].opts.live));
    t.eq('button shows "Approving…" while the batch runs', labelDuring, 'Approving…');
    const okStatus = findByClass(r.sheet.body, 'db-status--ok');
    t.ok('on success: inline "✓ 2 dry-run approvals logged · 1 blocked · nothing sent", sheet closes, onApprove fed',
      closed === 1 && approved.length === 1 && approved[0].ok === true && !!okStatus &&
      okStatus._text === '✓ 2 dry-run approvals logged · 1 blocked · nothing sent');

    // ===== { ok:false } keeps the sheet OPEN ===================================
    approveResult = { ok: false, reason: 'EMPTY_BUNDLE' };
    const r2 = BUNDLE.open(makeBundle(), {});
    const approve2 = findByClass(r2.sheet.body, 'db-btn--approve');
    btnRef = approve2;
    const closedBefore = closed;
    await approve2.onclick();
    const errStatus = findByClass(r2.sheet.body, 'db-status--error');
    t.ok('on { ok:false } the sheet stays OPEN with an inline error and the button re-arms',
      closed === closedBefore && !!errStatus && /Could not approve/.test(errStatus._text) &&
      /nothing was sent/.test(errStatus._text) && approve2.disabled === false && approve2._text === 'Approve All (3)');

    // ===== Cancel closes WITHOUT approving =====================================
    approveResult = { ok: true, dryRun: true, dispatched: false, total: 3, approved: 3, blocked: 0, results: [] };
    let rejected = 0;
    const r3 = BUNDLE.open(makeBundle(), { onReject: () => { rejected++; } });
    const cancel3 = findByClass(r3.sheet.body, 'db-btn--cancel');
    const callsBefore = calls.length;
    cancel3.onclick();
    t.ok('Cancel closes the sheet, fires onReject, and NEVER calls approveBundle',
      closed === closedBefore + 1 && rejected === 1 && calls.length === callsBefore);

    // ===== a missing engine degrades honestly ==================================
    delete G.AAA_DECISION_INBOX;
    const r4 = BUNDLE.open(makeBundle(), {});
    const approve4 = findByClass(r4.sheet.body, 'db-btn--approve');
    const closed4 = closed;
    await approve4.onclick();
    const err4 = findByClass(r4.sheet.body, 'db-status--error');
    t.ok('without AAA_DECISION_INBOX Approve All shows NO_INBOX inline and stays open (no throw)',
      closed === closed4 && !!err4 && /NO_INBOX/.test(err4._text));

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
