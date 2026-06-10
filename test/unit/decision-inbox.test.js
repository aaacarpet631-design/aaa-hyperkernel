/* Decision Inbox — governed, DRY-RUN-ONLY decision cards.
 *
 * Guards the pilot's hard safety constraint: approving a decision NEVER sends
 * anything. buildFollowUpDecision must derive EV/confidence/rationale from the
 * REAL Opportunity Scorer (never invent), the recipient from the real quote /
 * customer stores, and dispatch must: re-validate, pass the real safety gate
 * (a human tap satisfies needs_approval; only deny blocks), publish a typed
 * 'decision.approved' event, append a PII-minimal audit record (name + quote,
 * NEVER the phone number), and return dry-run — even when told { live:true }. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('decision-inbox');
  const { G, data } = setupEnv();
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/opportunity-scorer.js');
  load('js/customers/customer-store.js');
  load('js/agents/action-safety-gate.js');
  load('js/core/aaa-event-bus.js');
  load('js/governance/audit-ledger.js');

  // customer store reads AAA_LOCAL_FIRST_STORAGE — give it an in-memory one.
  const cstore = {};
  G.AAA_LOCAL_FIRST_STORAGE = {
    async getAll(c) { return Object.values(cstore[c] || {}); },
    async get(c, id) { return (cstore[c] || {})[id] || null; },
    async put(c, id, v) { (cstore[c] = cstore[c] || {})[id] = v; return v; }
  };
  cstore.customers = { cust1: { id: 'cust1', name: 'Henderson', phone: '7025550192' } };

  load('js/intelligence/decision-inbox.js');
  const INBOX = G.AAA_DECISION_INBOX;

  function seed(id, q) {
    return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', createdAt: '2026-05-01T00:00:00Z' }, q));
  }
  // resolved history → overall winRate 0.5; lost $300 puts the $200–500 band at 0/1.
  await seed('h1', { status: 'won', serviceType: ['carpet_clean'], customerTotal: 600, finalPrice: 600, wonLostReason: 'value' });
  await seed('h2', { status: 'lost', serviceType: ['carpet_clean'], customerTotal: 300, wonLostReason: 'price' });
  // open pipeline:
  //   qf1 follow_up_due $450 (band 0/1 → segment_blend ≈0.375, EV 169) — phone via customer store
  //   qf2 follow_up_due $2000 (no segments → overall 0.5, EV 1000) — phone on the quote
  //   qf3 sent $100, NO phone anywhere
  //   qf4 sent $5000 → biggest EV (2500) but urgency this_week → NOT auto-eligible
  await seed('qf1', { status: 'follow_up_due', customerTotal: 450, customerName: 'Henderson', customerId: 'cust1', serviceType: ['repair'], zip: '11111', leadSource: 'flyer' });
  await seed('qf2', { status: 'follow_up_due', customerTotal: 2000, customerName: 'Marina Bay', serviceType: ['tile'], customerContact: { phone: '+1 (702) 555-7788' } });
  await seed('qf3', { status: 'sent', customerTotal: 100, customerName: 'NoPhone', serviceType: ['rug'] });
  await seed('qf4', { status: 'sent', customerTotal: 5000, customerName: 'BigSlow', serviceType: ['plank'], customerContact: { phone: '7025559999' } });

  t.ok('FLAGS pinned: cards on, dry-run on', INBOX.FLAGS && INBOX.FLAGS.cardsEnabled === true && INBOX.FLAGS.dryRun === true);

  // ===== build from a real follow_up_due quote ==============================
  const r1 = await INBOX.buildFollowUpDecision({ quoteId: 'qf1' });
  t.ok('buildFollowUpDecision ok for a follow_up_due quote', r1.ok === true && !!r1.card);
  const card = r1.card;
  const val = INBOX.validateDecisionSchema(card);
  t.ok('built card is schema-valid', val.valid === true);
  const sc = await G.AAA_OPPORTUNITY_SCORER.score(await G.AAA_QUOTES.get('qf1'));
  t.eq('confidenceScore = the scorer probability', card.proposal.metrics.confidenceScore, sc.probability);
  t.eq('expectedValueUSD = the scorer expectedValue', card.proposal.metrics.expectedValueUSD, sc.expectedValue);
  t.ok('rationale is the honest scorer basis (segment blend → "closed at NN%")',
    sc.basis.method === 'segment_blend' && card.proposal.metrics.rationale === 'Similar quotes in this segment closed at ' + sc.probabilityPct + '%');
  t.eq('recipient resolved through AAA_CUSTOMER_STORE (customer.phone)', card.proposal.payload.recipient, '7025550192');
  t.ok('body references the customer by NAME only — no phone in the body',
    card.proposal.payload.body.indexOf('Henderson') !== -1 && card.proposal.payload.body.indexOf('7025550192') === -1);
  t.ok('trigger identifies the quote + customer', card.trigger.event === 'quote.follow_up_due' &&
    card.trigger.payload.quoteId === 'qf1' && card.trigger.payload.customerId === 'cust1' && card.trigger.payload.customerName === 'Henderson');
  t.ok('agent + governance enums exact', card.agent === 'SalesDirectorAI' &&
    card.governance.status === 'AWAITING_APPROVAL' && card.governance.policy === 'MANUAL_REVIEW_REQUIRED' &&
    card.schemaVersion === '1.0' && card.proposal.actionType === 'SEND_COMMUNICATION' && card.proposal.channel === 'SMS');

  // ===== auto-pick: highest EV among URGENT (now/today) quotes only =========
  const auto = await INBOX.buildFollowUpDecision();
  t.ok('no quoteId → picks highest-EV urgent quote (qf2, NOT the bigger this_week qf4)',
    auto.ok === true && auto.card.trigger.payload.quoteId === 'qf2');
  t.eq('auto-picked card pulls the phone straight off the quote contact', auto.card.proposal.payload.recipient, '+1 (702) 555-7788');

  // ===== missing phone is an honest refusal =================================
  const nop = await INBOX.buildFollowUpDecision({ quoteId: 'qf3' });
  t.ok('quote with no phone anywhere → NO_RECIPIENT', nop.ok === false && nop.reason === 'NO_RECIPIENT');

  // ===== validateDecisionSchema rejects each broken variant ==================
  const clone = (c) => JSON.parse(JSON.stringify(c));
  let b = clone(card); b.proposal.metrics.confidenceScore = 1.4;
  t.ok('rejects confidenceScore > 1', INBOX.validateDecisionSchema(b).valid === false);
  b = clone(card); b.proposal.metrics.expectedValueUSD = -5;
  t.ok('rejects negative expectedValueUSD', INBOX.validateDecisionSchema(b).valid === false);
  b = clone(card); b.proposal.payload.body = '';
  t.ok('rejects empty body', INBOX.validateDecisionSchema(b).valid === false);
  b = clone(card); delete b.proposal.payload.recipient;
  t.ok('rejects missing recipient', INBOX.validateDecisionSchema(b).valid === false);
  b = clone(card); delete b.trigger;
  t.ok('rejects missing trigger', INBOX.validateDecisionSchema(b).valid === false);
  b = clone(card); b.proposal.actionType = 'DELETE_EVERYTHING';
  t.ok('rejects a wrong actionType enum', INBOX.validateDecisionSchema(b).valid === false);

  // ===== dispatch: governed, audited, DRY-RUN ================================
  let busDelivered = null;
  G.AAA_EVENTS.on('event.decision.approved', (rec) => { busDelivered = rec; });
  const d1 = await INBOX.dispatch(card, {});
  t.ok('dispatch → { ok:true, dryRun:true, dispatched:false }',
    d1.ok === true && d1.dryRun === true && d1.dispatched === false && d1.decisionId === card.decisionId);
  t.eq('the REAL gate flags outbound SMS needs_approval — satisfied by the human tap, not a block', d1.gate, 'needs_approval');
  const evLog = await G.AAA_EVENT_BUS.log({ type: 'decision.approved' });
  t.ok('typed decision.approved event published to the bus log',
    evLog.length === 1 && evLog[0].payload.decisionId === card.decisionId && evLog[0].payload.quoteId === 'qf1' && evLog[0].payload.dryRun === true && !!busDelivered);
  const chain = await G.AAA_AUDIT_LEDGER.chain();
  const aud = chain.filter((e) => e.type === 'decision_approved');
  t.ok('audit ledger has the decision_approved record',
    aud.length === 1 && aud[0].payload.kind === 'decision_approved' && aud[0].payload.decisionId === card.decisionId &&
    aud[0].payload.dryRun === true && aud[0].payload.dispatched === false && aud[0].payload.customerName === 'Henderson');
  t.ok('audit record is PII-minimal — the phone number is NOT in it',
    JSON.stringify(aud[0]).indexOf('7025550192') === -1 && JSON.stringify(aud[0]).indexOf(card.proposal.payload.recipient) === -1);

  // ===== the HARD GUARD: { live:true } is ignored ============================
  const d2 = await INBOX.dispatch(card, { live: true });
  t.ok('dispatch({live:true}) STILL dry-runs — guard holds',
    d2.ok === true && d2.dryRun === true && d2.dispatched === false);

  // ===== a denying gate blocks =================================================
  const savedGate = G.AAA_ACTION_GATE;
  G.AAA_ACTION_GATE = { assess: () => ({ decision: 'deny', level: 'critical', categories: ['destructive'], reasons: ['test deny'] }) };
  const d3 = await INBOX.dispatch(card, {});
  t.ok('gate deny → { ok:false, blocked:true } with a reason', d3.ok === false && d3.blocked === true && /deny/.test(d3.reason));
  G.AAA_ACTION_GATE = savedGate;
  const evAfterBlock = await G.AAA_EVENT_BUS.log({ type: 'decision.approved' });
  t.ok('a blocked dispatch publishes NO approval event', evAfterBlock.length === 2); // d1 + d2 only

  // ===== invalid card never reaches the gate =================================
  const d4 = await INBOX.dispatch({ decisionId: 'junk' }, {});
  t.ok('invalid card → ok:false with the schema reason', d4.ok === false && !!d4.reason && d4.dispatched !== true);

  // ===== degrade, never throw =================================================
  const sb = G.AAA_EVENT_BUS, sl = G.AAA_AUDIT_LEDGER;
  delete G.AAA_EVENT_BUS; delete G.AAA_AUDIT_LEDGER;
  const d5 = await INBOX.dispatch(card, {});
  t.ok('missing bus + ledger → still a dry-run result, skips noted',
    d5.ok === true && d5.dispatched === false && d5.skipped.indexOf('event') !== -1 && d5.skipped.indexOf('audit') !== -1);
  G.AAA_EVENT_BUS = sb; G.AAA_AUDIT_LEDGER = sl;

  const ss = G.AAA_OPPORTUNITY_SCORER; delete G.AAA_OPPORTUNITY_SCORER;
  const n1 = await INBOX.buildFollowUpDecision({ quoteId: 'qf1' });
  t.ok('no scorer → NO_SCORER, no throw', n1.ok === false && n1.reason === 'NO_SCORER');
  G.AAA_OPPORTUNITY_SCORER = ss;

  const sq = G.AAA_QUOTES; delete G.AAA_QUOTES;
  const n2 = await INBOX.buildFollowUpDecision();
  t.ok('no quote store → ok:false, no throw', n2.ok === false && n2.reason === 'NO_ELIGIBLE_QUOTE');
  G.AAA_QUOTES = sq;

  const n3 = await INBOX.buildFollowUpDecision({ quoteId: 'nope' });
  t.ok('unknown quoteId → NO_ELIGIBLE_QUOTE', n3.ok === false && n3.reason === 'NO_ELIGIBLE_QUOTE');
  const n4 = await INBOX.buildFollowUpDecision({ quoteId: 'h1' });
  t.ok('a resolved (won) quote is not eligible', n4.ok === false && n4.reason === 'NO_ELIGIBLE_QUOTE');

  // ===== listDecisions: the ranked, approve-able feed ========================
  // qf5: urgent and the BIGGEST EV (0.5 × $9,999 → 5000) but NO phone anywhere
  // → skipped honestly, and the skip must not consume the limit.
  await seed('qf5', { status: 'follow_up_due', customerTotal: 9999, customerName: 'GhostPhone', serviceType: ['ghost'] });
  const ld = await INBOX.listDecisions();
  t.ok('listDecisions ranks the urgent quotes by expectedValue desc (qf2 $1000 then qf1 $169)',
    ld.ok === true && ld.count === 2 && ld.decisions.length === 2 &&
    ld.decisions[0].trigger.payload.quoteId === 'qf2' && ld.decisions[1].trigger.payload.quoteId === 'qf1');
  t.ok('every returned decision is a schema-valid card',
    ld.decisions.every((c) => INBOX.validateDecisionSchema(c).valid === true));
  t.eq('totalImpactUSD sums expectedValueUSD across the returned decisions (1000 + 169)', ld.totalImpactUSD, 1169);
  t.ok('non-urgent quotes stay out of the feed (qf4 has a bigger EV but urgency this_week)',
    ld.decisions.every((c) => c.trigger.payload.quoteId !== 'qf4'));
  t.ok('an urgent quote with no phone is skipped, not an error (qf5 absent)',
    ld.decisions.every((c) => c.trigger.payload.quoteId !== 'qf5'));
  t.eq('feed cards use the same construction path (qf1 recipient via AAA_CUSTOMER_STORE)',
    ld.decisions[1].proposal.payload.recipient, '7025550192');
  const ld1 = await INBOX.listDecisions({ limit: 1 });
  t.ok('limit caps RETURNED cards — the unbuildable qf5 does not consume it (top card is qf2)',
    ld1.ok === true && ld1.count === 1 && ld1.decisions.length === 1 &&
    ld1.decisions[0].trigger.payload.quoteId === 'qf2' && ld1.totalImpactUSD === 1000);

  // no eligible (urgent) quotes → an honest empty, NOT an error
  const savedScoreAll = G.AAA_OPPORTUNITY_SCORER.scoreAll;
  G.AAA_OPPORTUNITY_SCORER.scoreAll = async () => ({ ok: true, items: [
    { ok: true, quoteId: 'qf4', probability: 0.5, probabilityPct: 50, expectedValue: 2500, amount: 5000,
      basis: { method: 'overall_rate' }, recommendedAction: { id: 'follow_up', label: 'Follow up' }, urgency: 'this_week', confidence: 'low' }
  ], rankedBy: 'expectedValue' });
  const ldEmpty = await INBOX.listDecisions();
  t.ok('no eligible quotes → { ok:true, count:0, totalImpactUSD:0 } honest empty',
    ldEmpty.ok === true && ldEmpty.count === 0 && ldEmpty.decisions.length === 0 && ldEmpty.totalImpactUSD === 0 && !ldEmpty.reason);
  G.AAA_OPPORTUNITY_SCORER.scoreAll = savedScoreAll;

  // null-safe degradations — never a throw
  const ldsc = G.AAA_OPPORTUNITY_SCORER; delete G.AAA_OPPORTUNITY_SCORER;
  let ldNoSc = null, ldThrew = null;
  try { ldNoSc = await INBOX.listDecisions(); } catch (e) { ldThrew = e; }
  G.AAA_OPPORTUNITY_SCORER = ldsc;
  t.ok('no scorer → { ok:false, reason:NO_SCORER } with zeroed totals, no throw',
    ldThrew === null && ldNoSc.ok === false && ldNoSc.reason === 'NO_SCORER' &&
    ldNoSc.count === 0 && ldNoSc.decisions.length === 0 && ldNoSc.totalImpactUSD === 0);
  const ldq = G.AAA_QUOTES; delete G.AAA_QUOTES;
  const ldNoQ = await INBOX.listDecisions();
  G.AAA_QUOTES = ldq;
  t.ok('no quote store → ok:false NO_SCORER, no throw',
    ldNoQ.ok === false && ldNoQ.reason === 'NO_SCORER' && ldNoQ.decisions.length === 0);

  // ════════════════ Stage 2 compression: listBundles ════════════════════════
  const lb = await INBOX.listBundles();
  t.ok('listBundles groups the 2 same-family decisions into ONE revenue_recovery bundle',
    lb.ok === true && lb.bundles.length === 1 && lb.bundles[0].key === 'revenue_recovery' &&
    lb.bundles[0].label === 'Revenue Recovery' && lb.bundles[0].count === 2 &&
    lb.loose.length === 0 && lb.count === 2);
  const bun = lb.bundles[0];
  t.ok('bundle members ranked by expectedValueUSD desc (qf2 $1000 then qf1 $169)',
    bun.decisions[0].trigger.payload.quoteId === 'qf2' && bun.decisions[1].trigger.payload.quoteId === 'qf1');
  t.eq('bundle totalImpactUSD sums the member EVs', bun.totalImpactUSD, 1169);
  t.eq('bundle avgConfidencePct = rounded mean of member confidenceScores',
    bun.avgConfidencePct,
    Math.round((bun.decisions[0].proposal.metrics.confidenceScore + bun.decisions[1].proposal.metrics.confidenceScore) / 2 * 100));
  t.ok('cards carry the source action id (call_now for follow_up_due) and ACTION_BUNDLE maps it',
    bun.decisions.every((c) => c.trigger.payload.recommendedActionId === 'call_now') &&
    INBOX.ACTION_BUNDLE.call_now.key === 'revenue_recovery' &&
    INBOX.ACTION_BUNDLE.follow_up.key === 'revenue_recovery' && INBOX.ACTION_BUNDLE.send_quote.key === 'revenue_recovery');
  t.eq('top-level totalImpactUSD spans bundles + loose', lb.totalImpactUSD, 1169);

  // a SINGLE decision of a key stays loose — no 1-member bundle
  const sa2 = G.AAA_OPPORTUNITY_SCORER.scoreAll;
  const mkItem = (quoteId, probability, expectedValue, actionId) => ({
    ok: true, quoteId, probability, probabilityPct: Math.round(probability * 100), expectedValue,
    amount: Math.round(expectedValue / probability), basis: { method: 'overall_rate' },
    recommendedAction: { id: actionId, label: actionId }, urgency: 'now', confidence: 'low'
  });
  G.AAA_OPPORTUNITY_SCORER.scoreAll = async () => ({ ok: true, items: [mkItem('qf2', 0.5, 1000, 'call_now')], rankedBy: 'expectedValue' });
  const lbSingle = await INBOX.listBundles();
  t.ok('a singleton of a key stays LOOSE (≥2 forms a bundle)',
    lbSingle.ok === true && lbSingle.bundles.length === 0 && lbSingle.loose.length === 1 &&
    lbSingle.loose[0].trigger.payload.quoteId === 'qf2' && lbSingle.count === 1 && lbSingle.totalImpactUSD === 1000);

  // ACTION_BUNDLE is extensible: remap a family → its OWN bundle, impact-ranked
  await seed('qf6', { status: 'sent', customerTotal: 200, customerName: 'Smalls', serviceType: ['rug2'], customerContact: { phone: '7025550001' } });
  const savedCallNow = INBOX.ACTION_BUNDLE.call_now;
  INBOX.ACTION_BUNDLE.call_now = { key: 'call_blitz', label: 'Call Blitz' };
  G.AAA_OPPORTUNITY_SCORER.scoreAll = async () => ({ ok: true, items: [
    mkItem('qf4', 0.5, 2500, 'follow_up'), mkItem('qf2', 0.5, 1000, 'follow_up'),
    mkItem('qf1', 0.375, 169, 'call_now'), mkItem('qf6', 0.5, 100, 'call_now')
  ], rankedBy: 'expectedValue' });
  const lbMulti = await INBOX.listBundles({ limit: 10 });
  t.ok('a remapped action family forms a SECOND bundle, ranked by totalImpactUSD desc',
    lbMulti.ok === true && lbMulti.bundles.length === 2 &&
    lbMulti.bundles[0].key === 'revenue_recovery' && lbMulti.bundles[0].totalImpactUSD === 3500 &&
    lbMulti.bundles[1].key === 'call_blitz' && lbMulti.bundles[1].label === 'Call Blitz' &&
    lbMulti.bundles[1].totalImpactUSD === 269 && lbMulti.count === 4 && lbMulti.totalImpactUSD === 3769);
  INBOX.ACTION_BUNDLE.call_now = savedCallNow;

  // honest empty + propagated failure — never a throw
  G.AAA_OPPORTUNITY_SCORER.scoreAll = async () => ({ ok: true, items: [], rankedBy: 'expectedValue' });
  const lbEmpty = await INBOX.listBundles();
  t.ok('no decisions → ok:true with empty bundles + loose',
    lbEmpty.ok === true && lbEmpty.bundles.length === 0 && lbEmpty.loose.length === 0 &&
    lbEmpty.count === 0 && lbEmpty.totalImpactUSD === 0 && !lbEmpty.reason);
  G.AAA_OPPORTUNITY_SCORER.scoreAll = sa2;
  const lbsc = G.AAA_OPPORTUNITY_SCORER; delete G.AAA_OPPORTUNITY_SCORER;
  let lbNoSc = null, lbThrew = null;
  try { lbNoSc = await INBOX.listBundles(); } catch (e) { lbThrew = e; }
  G.AAA_OPPORTUNITY_SCORER = lbsc;
  t.ok('no scorer → propagated { ok:false, reason:NO_SCORER } with zeroed empties, no throw',
    lbThrew === null && lbNoSc.ok === false && lbNoSc.reason === 'NO_SCORER' &&
    lbNoSc.bundles.length === 0 && lbNoSc.loose.length === 0 && lbNoSc.totalImpactUSD === 0 && lbNoSc.count === 0);

  // ════════════════ approveBundle: N dry-run governed approvals ═════════════
  // transport spies — Approve All must NEVER touch any send path.
  let sends = 0;
  const sendSpy = () => { sends++; return { ok: true }; };
  G.AAA_TRANSPORT = { send: sendSpy, sendSMS: sendSpy };
  G.AAA_TRANSPORT_DELIVERY = { send: sendSpy, deliver: sendSpy };
  G.AAA_SMS = { send: sendSpy };
  const savedFetch = G.fetch;
  G.fetch = () => { sends++; return Promise.resolve({ ok: true }); };

  const evBefore = (await G.AAA_EVENT_BUS.log({ type: 'decision.approved' })).length;
  const audBefore = (await G.AAA_AUDIT_LEDGER.chain()).filter((e) => e.type === 'decision_approved').length;
  const ab = await INBOX.approveBundle(bun, {});
  t.ok('approveBundle → { ok:true, dryRun:true, dispatched:false, total:2, approved:2, blocked:0 }',
    ab.ok === true && ab.dryRun === true && ab.dispatched === false &&
    ab.total === 2 && ab.approved === 2 && ab.blocked === 0);
  t.ok('per-member results carry each decisionId with ok:true',
    ab.results.length === 2 && ab.results[0].decisionId === bun.decisions[0].decisionId &&
    ab.results[1].decisionId === bun.decisions[1].decisionId && ab.results.every((r) => r.ok === true));
  const evAfter = await G.AAA_EVENT_BUS.log({ type: 'decision.approved' });
  t.ok('every member published its own decision.approved event (all dryRun:true)',
    evAfter.length === evBefore + 2 && evAfter.slice(-2).every((e) => e.payload.dryRun === true));
  const audAfter = (await G.AAA_AUDIT_LEDGER.chain()).filter((e) => e.type === 'decision_approved');
  t.ok('every member appended its own audit entry, each dispatched:false',
    audAfter.length === audBefore + 2 &&
    audAfter.slice(-2).every((e) => e.payload.dispatched === false && e.payload.dryRun === true));
  t.eq('ZERO messages sent — no transport/fetch invoked by the batch', sends, 0);

  // the headline guarantee: a bundle of 17 → 17 audit entries, nothing sent,
  // even when told { live:true } (the HARD GUARD holds at both layers).
  const seventeen = {
    id: 'bundle_revenue_recovery', key: 'revenue_recovery', label: 'Revenue Recovery',
    decisions: Array.from({ length: 17 }, (_, i) => { const c = clone(card); c.decisionId = 'dec_batch_' + i; return c; }),
    count: 17, totalImpactUSD: 17 * 169, avgConfidencePct: 38
  };
  const ev17Before = (await G.AAA_EVENT_BUS.log({ type: 'decision.approved' })).length;
  const aud17Before = (await G.AAA_AUDIT_LEDGER.chain()).filter((e) => e.type === 'decision_approved').length;
  const ab17 = await INBOX.approveBundle(seventeen, { live: true }); // live is IGNORED
  const ev17 = (await G.AAA_EVENT_BUS.log({ type: 'decision.approved' })).length;
  const aud17 = (await G.AAA_AUDIT_LEDGER.chain()).filter((e) => e.type === 'decision_approved').length;
  t.ok('a bundle of 17 → 17 dry-run approvals, 17 events, 17 audit entries — dispatched:false despite {live:true}',
    ab17.ok === true && ab17.dryRun === true && ab17.dispatched === false &&
    ab17.total === 17 && ab17.approved === 17 && ab17.blocked === 0 && ab17.results.length === 17 &&
    ev17 === ev17Before + 17 && aud17 === aud17Before + 17);
  t.eq('still ZERO messages sent after 19 batched approvals', sends, 0);

  // one bad apple doesn't abort the batch
  const badApple = { key: 'revenue_recovery', label: 'Revenue Recovery',
    decisions: [clone(bun.decisions[0]), { decisionId: 'junk_card' }, clone(bun.decisions[1])] };
  const abBad = await INBOX.approveBundle(badApple, {});
  t.ok('an invalid member is recorded with its reason and the batch CONTINUES (approved 2, blocked 1)',
    abBad.ok === true && abBad.total === 3 && abBad.approved === 2 && abBad.blocked === 1 &&
    abBad.results[0].ok === true && abBad.results[2].ok === true &&
    abBad.results[1].ok === false && !!abBad.results[1].reason);

  // a gate-denied member reports blocked:true; the batch still returns ok:true
  const gateSave = G.AAA_ACTION_GATE;
  G.AAA_ACTION_GATE = { assess: () => ({ decision: 'deny', level: 'critical', categories: ['destructive'], reasons: ['bundle test deny'] }) };
  const abDeny = await INBOX.approveBundle({ decisions: [clone(card)] }, {});
  G.AAA_ACTION_GATE = gateSave;
  t.ok('a gate-denied member is counted blocked with blocked:true on its result',
    abDeny.ok === true && abDeny.approved === 0 && abDeny.blocked === 1 &&
    abDeny.results[0].blocked === true && abDeny.dispatched === false);

  // null-safety: empty / absent bundle
  const abNull = await INBOX.approveBundle(null, {});
  const abEmpty = await INBOX.approveBundle({ decisions: [] }, {});
  t.ok('empty/absent bundle → { ok:false, reason:EMPTY_BUNDLE }, no throw',
    abNull.ok === false && abNull.reason === 'EMPTY_BUNDLE' &&
    abEmpty.ok === false && abEmpty.reason === 'EMPTY_BUNDLE');

  delete G.AAA_TRANSPORT; delete G.AAA_TRANSPORT_DELIVERY; delete G.AAA_SMS;
  if (savedFetch === undefined) delete G.fetch; else G.fetch = savedFetch;

  return t.report();
};
