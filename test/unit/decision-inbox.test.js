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

  return t.report();
};
