/* Decision Card UI — the one-tap approval sheet.
 *
 * Guards the regression that motivated this surface: AAA_UI.sheet() returns
 * { overlay, body, close } and the CALLER must append the overlay to
 * document.body or the sheet is invisible on a real phone while every Node
 * suite stays green. Also guards: masked recipient (no full phone in the DOM),
 * esc() on everything, Approve → dispatch → close on success / stay open on
 * failure, Reject → close without dispatching. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (same shape the command-deck suite uses) --------------
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

function makeCard(over) {
  const c = {
    decisionId: 'dec_test_1', schemaVersion: '1.0',
    trigger: { event: 'quote.follow_up_due', timestamp: '2026-06-10T12:00:00Z', payload: { quoteId: 'q1', customerId: 'cust1', customerName: 'Henderson' } },
    agent: 'SalesDirectorAI',
    proposal: {
      actionType: 'SEND_COMMUNICATION', channel: 'SMS', templateId: 'followup_sms_v1',
      metrics: { expectedValueUSD: 169, confidenceScore: 0.375, rationale: 'Similar quotes in this segment closed at 38%' },
      payload: { recipient: '+1 (702) 555-0192', body: 'Hi Henderson — just checking in on your AAA Carpet estimate.' }
    },
    governance: { status: 'AWAITING_APPROVAL', policy: 'MANUAL_REVIEW_REQUIRED' }
  };
  return Object.assign(c, over || {});
}

module.exports = async function run() {
  const t = makeRunner('decision-card-ui');
  const { G } = setupEnv();
  try {
    load('js/ui/decision-card-ui.js');
    const CARD = G.AAA_DECISION_CARD;

    // ===== DOM guard ==========================================================
    delete global.document;
    const noDom = CARD.open(makeCard());
    t.ok('open() without a document → { opened:false, reason:"no_dom" }', noDom.opened === false && noDom.reason === 'no_dom');

    installDom();

    // ===== stubs: sheet (tracked) + inbox dispatch ===========================
    let closed = 0;
    G.AAA_UI = { sheet: () => ({ overlay: makeEl(), body: makeEl(), close: () => { closed++; } }) };
    const calls = [];
    let dispatchResult = { ok: true, dryRun: true, dispatched: false, decisionId: 'dec_test_1' };
    let labelDuringDispatch = null;
    let approveBtnRef = null;
    G.AAA_DECISION_INBOX = { dispatch: async (card, opts) => { calls.push({ card, opts }); if (approveBtnRef) labelDuringDispatch = approveBtnRef._text; return dispatchResult; } };

    // ===== open + render =======================================================
    const card = makeCard();
    const approved = []; let rejected = 0;
    const r = CARD.open(card, { onApprove: (res) => approved.push(res), onReject: () => { rejected++; } });
    t.ok('open() returns { opened:true, sheet }', r.opened === true && !!r.sheet);
    t.ok('THE REGRESSION GUARD: overlay is APPENDED to document.body',
      global.document.body.children.indexOf(r.sheet.overlay) !== -1);
    const html = htmlOf(r.sheet.body);
    t.ok('renders the big Expected Value from metrics', html.indexOf('$169') !== -1);
    t.ok('renders the confidence as a rounded percentage', html.indexOf('38% confidence') !== -1);
    t.ok('renders the one-line rationale', html.indexOf('closed at 38%') !== -1);
    t.ok('renders the trigger line (event — customer)', html.indexOf('Follow-up due — Henderson') !== -1);
    t.ok('recipient is MASKED: name + last 4 only, full phone NOT in the DOM',
      html.indexOf('SMS to Henderson · ••• 0192') !== -1 && html.indexOf('555-0192') === -1 && html.indexOf('(702)') === -1 && html.indexOf('7025550192') === -1);

    // ===== Approve → dispatch → success closes ================================
    const approveBtn = findByClass(r.sheet.body, 'dc-btn--approve');
    const rejectBtn = findByClass(r.sheet.body, 'dc-btn--reject');
    t.ok('Approve + Reject buttons rendered with the right labels',
      !!approveBtn && approveBtn._text === 'Approve Send' && !!rejectBtn && rejectBtn._text === 'Reject');
    approveBtnRef = approveBtn;
    await approveBtn.onclick();
    t.ok('Approve calls AAA_DECISION_INBOX.dispatch with THE card', calls.length === 1 && calls[0].card === card);
    t.eq('button shows "Sending…" while dispatching', labelDuringDispatch, 'Sending…');
    t.ok('on { ok:true } the sheet closes and onApprove gets the result',
      closed === 1 && approved.length === 1 && approved[0].ok === true);
    const okStatus = findByClass(r.sheet.body, 'dc-status--ok');
    t.ok('inline dry-run confirmation shown (no message sent)',
      !!okStatus && /Dry-run dispatched & logged \(no message sent\)/.test(okStatus._text));

    // ===== Approve failure keeps the sheet OPEN ===============================
    dispatchResult = { ok: false, blocked: true, reason: 'denied by safety gate' };
    const r2 = CARD.open(makeCard(), {});
    const approve2 = findByClass(r2.sheet.body, 'dc-btn--approve');
    approveBtnRef = approve2;
    const closedBefore = closed;
    await approve2.onclick();
    const errStatus = findByClass(r2.sheet.body, 'dc-status--error');
    t.ok('on { ok:false } the sheet stays OPEN with an inline error',
      closed === closedBefore && !!errStatus && /Blocked by the safety gate/.test(errStatus._text));
    t.ok('the Approve button is re-armed after a failure', approve2.disabled === false && approve2._text === 'Approve Send');

    // ===== Reject closes without dispatching ==================================
    dispatchResult = { ok: true, dryRun: true, dispatched: false };
    let rejected3 = 0;
    const r3 = CARD.open(makeCard(), { onReject: () => { rejected3++; } });
    const reject3 = findByClass(r3.sheet.body, 'dc-btn--reject');
    const callsBefore = calls.length;
    reject3.onclick();
    t.ok('Reject closes the sheet, fires onReject, and NEVER dispatches',
      closed === closedBefore + 1 && rejected3 === 1 && calls.length === callsBefore);

    // ===== everything is esc()'d ===============================================
    const evil = makeCard();
    evil.trigger.payload.customerName = '<script>alert(1)</script>';
    const r4 = CARD.open(evil, {});
    const evilHtml = htmlOf(r4.sheet.body);
    t.ok('hostile customerName is escaped in the DOM html',
      evilHtml.indexOf('&lt;script&gt;') !== -1 && evilHtml.indexOf('<script>') === -1);

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
