/* Copilot Context Packet — Slice C: the deterministic, permission-scoped view
 * the intelligence layer is allowed to see.
 *
 * Guards: every packet is contract-valid or refused; customer PII never
 * enters a packet (whitelist construction, proven by planting names/phones);
 * financial fields exist only for VIEW_FINANCIALS roles; customer free text
 * ships untrusted:true; foreign-workspace records are invisible; same store +
 * same clock → byte-identical packet; and assembly is read-only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-context-packet');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-09T15:00:00.000Z' });
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js', 'js/governance/decision-envelope.js',
   'js/leads/lead-store.js', 'js/quotes/quote-store.js',
   'js/copilot/copilot-contract.js', 'js/copilot/context-packet.js'].forEach(load);
  const CTX = G.AAA_COPILOT_CONTEXT, C = G.AAA_COPILOT_CONTRACT, LEADS = G.AAA_LEADS, Q = G.AAA_QUOTES;
  const data = G.AAA_DATA;

  // ---- seed a small business world (with PII to prove redaction) ----
  const lead = (await LEADS.createLead({ name: 'Maria Gonzalez', phone: '7135559876', source: 'google_ads', serviceType: 'repair' })).lead;
  // age the lead so it is a stale NEW_LEAD (created "now", so backdate)
  const staleLead = Object.assign({}, lead, { createdAt: Date.parse('2026-07-08T15:00:00Z'), updatedAt: Date.parse('2026-07-08T15:00:00Z') });
  await data.put('leads', lead.leadId, staleLead);

  await data.put('customers', 'cust_1', { id: 'cust_1', name: 'Maria Gonzalez', phone: '7135559876', email: 'mg@x.com', address: '12 Oak St', notes: 'asked about pet-safe adhesive', preferredChannel: 'sms', workspaceId: 'ws_test' });
  const draft = await Q.createDraft({ estimate: { quote: { _laborTotal: 500, _materialTotal: 200, total: 1500 }, receipt: { total: 1500 } }, customerId: 'cust_1', customerName: 'Maria Gonzalez', leadId: lead.leadId, leadSource: 'google_ads' });
  await Q.markReviewed(draft.id, { actor: 'owner' });
  await Q.send(draft.id, { actor: 'owner' });
  // backdate the send so it lands in the follow-up queue (>3 days)
  const sentQuote = await Q.get(draft.id);
  await data.put('quotes', draft.id, Object.assign({}, sentQuote, { sentAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }));
  await data.put('outcomes', 'out_1', { id: 'out_1', result: 'won', serviceType: null, finalAmount: 2100, workspaceId: 'ws_test' });
  // a foreign-workspace quote that must be invisible
  await data.put('quotes', 'q_foreign', { quoteId: 'q_foreign', id: 'q_foreign', status: 'follow_up_due', workspaceId: 'ws_other', customerName: 'Other Tenant' });

  // ---- attention_today ----
  const att = await CTX.assemble('attention_today');
  t.ok('attention packet assembles and is contract-valid', att.ok && C.validateContextPacket(att.packet).ok);
  const attItems = att.packet.sections[0].items;
  t.ok('stale NEW lead is included with age, ids only', attItems.some((i) => i.sourceRef.id === lead.leadId && i.data.ageHours >= 24));
  t.ok('overdue quote is included', attItems.some((i) => i.sourceRef.collection === 'quotes' && i.sourceRef.id === draft.id));
  t.ok('foreign-workspace records are invisible', !JSON.stringify(att.packet).includes('q_foreign'));

  // ---- PII redaction: plant PII, prove absence ----
  const attStr = JSON.stringify(att.packet);
  t.ok('no customer PII in the packet (name/phone/email/address)',
    !attStr.includes('Maria') && !attStr.includes('7135559876') && !attStr.includes('mg@x.com') && !attStr.includes('Oak St'));
  t.ok('the packet declares its standing redactions', att.packet.redactions.indexOf('customer.phone') !== -1);

  // ---- determinism: same store + same clock → byte-identical ----
  const again = await CTX.assemble('attention_today');
  t.ok('same store + same clock → byte-identical packet', JSON.stringify(again.packet) === attStr);

  // ---- followups: financial fields are RBAC-scoped ----
  const asOwner = await CTX.assemble('followups');
  const ownerQuoteItem = asOwner.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('owner sees the quote total in followups', asOwner.ok && ownerQuoteItem.data.total === 1500);
  cfg.set({ role: 'crew' });
  const asCrew = await CTX.assemble('followups');
  const crewQuoteItem = asCrew.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('crew packet carries NO financial fields', asCrew.ok && crewQuoteItem && !('total' in crewQuoteItem.data));
  t.eq('crew packet declares its role', asCrew.packet.role, 'crew');
  cfg.set({ role: 'owner' });

  // ---- estimate_risk: margin only for VIEW_FINANCIALS ----
  const risk = await CTX.assemble('estimate_risk', { quoteId: draft.id });
  const riskQuote = risk.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('owner risk packet carries margin', risk.ok && riskQuote.data.grossMargin != null);
  cfg.set({ role: 'crew' });
  const riskCrew = await CTX.assemble('estimate_risk', { quoteId: draft.id });
  const riskCrewQuote = riskCrew.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('crew risk packet has NO margin/cost/total', !('grossMargin' in riskCrewQuote.data) && !('total' in riskCrewQuote.data));
  cfg.set({ role: 'owner' });
  t.eq('estimate_risk without a quoteId is refused', (await CTX.assemble('estimate_risk')).error, 'QUOTE_ID_REQUIRED');
  t.eq('unknown quote is an honest error', (await CTX.assemble('estimate_risk', { quoteId: 'ghost' })).error, 'QUOTE_NOT_FOUND');

  // ---- draft_followup: customer free text is untrusted, PII stays home ----
  const dctx = await CTX.assemble('draft_followup', { quoteId: draft.id });
  t.ok('draft context assembles', dctx.ok);
  const custItem = dctx.packet.sections[0].items.find((i) => i.sourceRef.collection === 'customers');
  t.ok('customer note ships untrusted:true', custItem && custItem.untrusted === true && /pet-safe/.test(custItem.data.note));
  t.ok('customer PII never ships even in draft context',
    !JSON.stringify(dctx.packet).includes('7135559876') && !JSON.stringify(dctx.packet).includes('Maria'));

  // ---- agent_activity ----
  const env = G.AAA_DECISION_ENVELOPE.wrap({ agent: 'agent:test', decision: { recommendation: 'do x', rationale: 'y', confidence: 80 } });
  await G.AAA_DECISION_ENVELOPE.seal(env.envelope);
  const act = await CTX.assemble('agent_activity');
  t.ok('agent activity includes sealed envelopes', act.ok && act.packet.sections[0].items.some((i) => i.sourceRef.collection === 'decision_envelopes'));

  // ---- honest failure modes + read-only ----
  t.eq('unknown job refused', (await CTX.assemble('world_domination')).error, 'UNKNOWN_JOB');
  const savedC = G.AAA_COPILOT_CONTRACT; delete G.AAA_COPILOT_CONTRACT;
  t.eq('no contract module → no packet', (await CTX.assemble('followups')).error, 'NO_CONTRACT');
  G.AAA_COPILOT_CONTRACT = savedC;
  const before = JSON.stringify(G.AAA_DATA._store);
  await CTX.assemble('attention_today'); await CTX.assemble('agent_activity');
  t.ok('assembly is read-only (store byte-identical)', JSON.stringify(G.AAA_DATA._store) === before);

  return t.report();
};
