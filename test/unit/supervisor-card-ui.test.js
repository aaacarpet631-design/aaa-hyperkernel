/*
 * Supervisor Evidence Card — renders a resolved pricing decision for fast human
 * approval, and routes the four actions through the floor-enforcing approval
 * layer. Verifies the card surfaces all required evidence, the four actions, and
 * the HARD RULE: no action may approve below the margin floor.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '', value: (opts && opts.attrs && opts.attrs.value) || '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  n.addEventListener = function () {};
  n.querySelector = function () { return null; };
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  Object.defineProperty(n, 'textContent', { get() { return n._text || ''; }, set(v) { n._text = String(v); } });
  return n;
}
function fakeUI() {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o),
    statusBadge: (label, color) => fakeNode('badge', { text: label, color: color }),
    spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }),
    confirm: async () => ({ reason: 'because' })
  };
}
function txt(n, acc) { if (!n || typeof n !== 'object') return acc; const o = n.opts || {}; if (o.text) acc.push(String(o.text)); if (o.html) acc.push(String(o.html)); if (o.label) acc.push(String(o.label)); (n.children || []).forEach((c) => txt(c, acc)); return acc; }
function findBtn(n, re) { if (!n || typeof n !== 'object') return null; if (n.tag === 'button' && n.opts && re.test(String(n.opts.label || ''))) return n; for (const c of (n.children || [])) { const f = findBtn(c, re); if (f) return f; } return null; }

module.exports = async function run() {
  const t = makeRunner('supervisor-card-ui');
  const { G } = setupEnv({});
  load('js/intelligence/pricing-resolver.js');
  load('js/governance/audit-ledger.js');
  load('js/ui/supervisor-card-ui.js');
  G.AAA_UI = fakeUI();
  const R = G.AAA_PRICING_RESOLVER;
  const L = G.AAA_AUDIT_LEDGER;
  const UI = G.AAA_SUPERVISOR_CARD_UI;
  const comps = (won, lost) => ({ comparables: [].concat(won.map((a) => ({ amount: a, outcome: 'won' })), (lost || []).map((a) => ({ amount: a, outcome: 'lost' }))) });

  // A normal in-range, confident decision (resolved → has decisionId + ledgerRef).
  const norm = await R.resolve({ anchor: { price: 1500 }, marginFloor: 1200, signals: comps([1300, 1320, 1340, 1360, 1380, 1400]), meta: { subjectType: 'quote', subjectId: 'q9' } });

  // ---- card surfaces every required evidence item -------------------------
  const c = fakeNode('div', {});
  UI.renderCard(c, norm);
  const card = txt(c, []).join(' || ');
  t.ok('1. recommended price shown', /Recommended price/.test(card) && card.indexOf('$' + norm.recommended.toLocaleString('en-US')) !== -1);
  t.ok('2. margin floor shown', /Margin floor/.test(card) && /\$1,200/.test(card));
  t.ok('3. anchor price shown', /Anchor \(price book\)/.test(card) && /\$1,500/.test(card));
  t.ok('4. winning + losing comp band shown', /Winning comps/.test(card) && /Losing comps/.test(card) && /win rate/.test(card));
  t.ok('5. decision confidence shown', /Confidence/.test(card) && /%/.test(card));
  t.ok('7. approval-required status shown', /Approval required/.test(card));
  t.ok('8. ledger citation / decision id shown', card.indexOf(norm.decisionId) !== -1 && /ledger/.test(card));
  t.ok('9. all four actions present', !!findBtn(c, /^Accept/) && !!findBtn(c, /Adjust within range/) && !!findBtn(c, /Send back for rescope/) && !!findBtn(c, /^Decline/));

  // ---- flags surface (use the worked unprofitable example) ----------------
  const unprof = await R.resolve({ anchor: { price: 2000 }, marginFloor: 1400, signals: comps([1250, 1300, 1350], [1500, 1600]) });
  const c2 = fakeNode('div', {});
  UI.renderCard(c2, unprof);
  const card2 = txt(c2, []).join(' || ');
  t.ok('6. headline flags rendered (unprofitable + floor clamped)', /Unprofitable to win/.test(card2) && /Floor clamped/.test(card2));
  t.ok('FLOOR_CLAMPED emitted by resolver on a band below floor', unprof.escalationFlags.indexOf('FLOOR_CLAMPED') !== -1);

  // ---- HARD RULE: no action may approve below the margin floor -------------
  const belowFloor = await UI.submit(norm, 'adjust', { price: 1000 }, {});
  t.ok('adjust below floor REFUSED (no approval)', belowFloor.ok === false && belowFloor.error === 'BELOW_MARGIN_FLOOR' && belowFloor.marginFloor === 1200);
  const aboveRange = await UI.submit(norm, 'adjust', { price: 999999 }, {});
  t.ok('adjust above allowed range refused', aboveRange.ok === false && aboveRange.error === 'ABOVE_ALLOWED_RANGE');
  // Direct on the resolver too (logic layer, defense in depth).
  t.eq('resolver refuses sub-floor adjust', (await R.recordApproval(norm, { action: 'adjust', price: 1 })).error, 'BELOW_MARGIN_FLOOR');
  // Even an unprofitable decision: accept lands at the floor, never below.
  const acceptUnprof = await R.recordApproval(unprof, { action: 'accept', actor: 'owner' });
  t.ok('accept on unprofitable = the floor, never below', acceptUnprof.ok === true && acceptUnprof.approvedPrice === 1400 && acceptUnprof.approvedPrice >= unprof.evidence.marginFloor);

  // ---- accept records an approval to the ledger ---------------------------
  let captured = null;
  const c3 = fakeNode('div', {});
  UI.renderCard(c3, norm, { actor: 'owner', onResolved: (r) => { captured = r; } });
  await findBtn(c3, /^Accept/).opts.onClick();
  t.ok('Accept approves at recommended', captured && captured.ok === true && captured.approved === true && captured.approvedPrice === norm.recommended);
  t.ok('Accept wrote a ledger ref', !!captured.approvalId && !!captured.ledgerRef);

  // ---- adjust within range succeeds ---------------------------------------
  const okAdjust = await UI.submit(norm, 'adjust', { price: 1300 }, { actor: 'owner' });
  t.ok('adjust within [floor, high] approved', okAdjust.ok === true && okAdjust.approved === true && okAdjust.approvedPrice === 1300);

  // ---- rescope / decline approve NO price ---------------------------------
  const back = await UI.submit(norm, 'rescope', { reason: 'need site visit' }, { actor: 'owner' });
  t.ok('rescope records, approves no price', back.ok === true && back.approved === false && back.approvedPrice === null);
  const dec = await UI.submit(norm, 'decline', { reason: 'not worth it' }, { actor: 'owner' });
  t.ok('decline records, approves no price', dec.ok === true && dec.approved === false && dec.approvedPrice === null);
  t.eq('unknown action rejected', (await R.recordApproval(norm, { action: 'nope' })).error, 'UNKNOWN_ACTION');

  // ---- ledger: approvals are PII-free and the chain verifies --------------
  const chain = await L.chain();
  const approvals = chain.filter((e) => e.type === 'pricing_approval');
  t.ok('approvals written to immutable ledger', approvals.length >= 4);
  t.ok('an approval references its decision + floor', approvals.some((e) => e.payload.decisionId === norm.decisionId && e.payload.marginFloor === 1200));
  t.ok('approval payloads carry no PII (no @, no email)', approvals.every((e) => JSON.stringify(e.payload).indexOf('@') === -1));
  t.ok('audit ledger verifies after approvals', (await L.verify()).ok === true);

  // ---- empty / invalid decision handled -----------------------------------
  const c4 = fakeNode('div', {});
  UI.renderCard(c4, { ok: false, error: 'ANCHOR_REQUIRED' });
  t.ok('invalid decision handled gracefully', /No pricing decision to review/.test(txt(c4, []).join(' ')));

  return t.report();
};
