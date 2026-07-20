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

  await data.put('customers', 'cust_1', { id: 'cust_1', name: 'Maria Gonzalez', phone: '7135559876', email: 'mg@x.com', address: '12 Oak St', notes: 'asked about pet-safe adhesive — call 713-555-9876 or mg@x.com', preferredChannel: 'sms', workspaceId: 'ws_test' });
  const draft = await Q.createDraft({ estimate: { quote: { _laborTotal: 500, _materialTotal: 200, total: 1500 }, receipt: { total: 1500 } }, customerId: 'cust_1', customerName: 'Maria Gonzalez', leadId: lead.leadId, leadSource: 'google_ads' });
  await Q.markReviewed(draft.id, { actor: 'owner' });
  await Q.send(draft.id, { actor: 'owner' });
  // backdate the send so it lands in the follow-up queue (>3 days)
  const sentQuote = await Q.get(draft.id);
  await data.put('quotes', draft.id, Object.assign({}, sentQuote, { sentAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }));
  await data.put('outcomes', 'out_1', { id: 'out_1', result: 'won', serviceType: null, finalAmount: 2100, workspaceId: 'ws_test' });
  // a foreign-workspace quote that must be invisible
  await data.put('quotes', 'q_foreign', { quoteId: 'q_foreign', id: 'q_foreign', status: 'follow_up_due', workspaceId: 'ws_other', customerName: 'Other Tenant' });
  // today's jobs: one scheduled (with PII that must never ship), one closed, one foreign
  await data.put('jobs', 'job_today', { id: 'job_today', currentState: 'SCHEDULED', scheduledFor: '2026-07-09T14:00:00.000Z', customerName: 'Maria Gonzalez', address: '12 Oak St', workspaceId: 'ws_test' });
  await data.put('jobs', 'job_closed', { id: 'job_closed', currentState: 'CLOSED', workspaceId: 'ws_test' });
  await data.put('jobs', 'job_foreign', { id: 'job_foreign', currentState: 'SCHEDULED', workspaceId: 'ws_other' });
  // an awaiting-approval envelope whose recommendation embeds a phone + email
  const pend = G.AAA_DECISION_ENVELOPE.wrap({ agent: 'agent:pricing', decision: { recommendation: 'Call the customer at 7135551234 or a@b.com to confirm', rationale: 'low confidence', confidence: 20 } });
  await G.AAA_DECISION_ENVELOPE.seal(pend.envelope);

  // ---- attention_today ----
  const att = await CTX.assemble('attention_today');
  t.ok('attention packet assembles and is contract-valid', att.ok && C.validateContextPacket(att.packet).ok);
  const attItems = att.packet.sections[0].items;
  t.ok('stale NEW lead is included with age, ids only', attItems.some((i) => i.sourceRef.id === lead.leadId && i.data.ageHours >= 24));
  t.ok('overdue quote is included', attItems.some((i) => i.sourceRef.collection === 'quotes' && i.sourceRef.id === draft.id));
  const jobItem = attItems.find((i) => i.sourceRef.collection === 'jobs');
  t.ok('today\'s scheduled job is included with state + scheduledFor, ids only',
    jobItem && jobItem.sourceRef.id === 'job_today' && jobItem.data.state === 'SCHEDULED' && jobItem.data.scheduledFor === '2026-07-09T14:00:00.000Z');
  t.ok('closed jobs stay out of attention', !attItems.some((i) => i.sourceRef.id === 'job_closed'));
  t.ok('foreign-workspace records are invisible', !JSON.stringify(att.packet).includes('q_foreign') && !JSON.stringify(att.packet).includes('job_foreign'));
  const envAtt = attItems.find((i) => i.sourceRef.collection === 'decision_envelopes');
  t.ok('envelope recommendation free text is scrubbed of phone/email',
    envAtt && envAtt.data.recommendation.includes('[redacted]') && !envAtt.data.recommendation.includes('7135551234') && !envAtt.data.recommendation.includes('a@b.com'));

  // ---- record-level asOf: the ref carries the record's age, not assembly time
  const quoteAtt = attItems.find((i) => i.sourceRef.collection === 'quotes');
  t.eq('sourceRef.asOf reflects the backdated record, not assembly time', quoteAtt.sourceRef.asOf, '2026-07-01T00:00:00.000Z');
  const leadAtt = attItems.find((i) => i.sourceRef.collection === 'leads');
  t.eq('lead asOf normalizes the numeric timestamp to ISO', leadAtt.sourceRef.asOf, '2026-07-08T15:00:00.000Z');
  t.eq('assembledAt stays on the fixed clock', att.packet.assembledAt, '2026-07-09T15:00:00.000Z');

  // ---- PII redaction: plant PII, prove absence ----
  const attStr = JSON.stringify(att.packet);
  t.ok('no customer PII in the packet (name/phone/email/address)',
    !attStr.includes('Maria') && !attStr.includes('7135559876') && !attStr.includes('mg@x.com') && !attStr.includes('Oak St'));
  t.ok('the packet declares its standing redactions', att.packet.redactions.indexOf('customer.phone') !== -1);

  // ---- determinism: same store + same clock → byte-identical ----
  const again = await CTX.assemble('attention_today');
  t.ok('same store + same clock → byte-identical packet', JSON.stringify(again.packet) === attStr);

  // ---- honest truncation at the section cap ----
  cfg.set({ copilotSectionMaxItems: 2 });
  const capped = await CTX.assemble('attention_today');
  const cappedSec = capped.packet.sections[0];
  t.ok('capped section keeps exactly the cap and stays contract-valid', capped.ok && cappedSec.items.length === 2 && C.validateContextPacket(capped.packet).ok);
  t.ok('capped section declares truncated:true', cappedSec.truncated === true);
  t.eq('omittedCount counts every dropped item', cappedSec.omittedCount, attItems.length - 2);
  t.ok('deterministic priority order: kept items are the byRefId head', JSON.stringify(cappedSec.items) === JSON.stringify(attItems.slice(0, 2)));
  cfg.set({ copilotSectionMaxItems: null });
  const uncapped = await CTX.assemble('attention_today');
  t.ok('below the cap no truncation flags ship', !('truncated' in uncapped.packet.sections[0]) && !('omittedCount' in uncapped.packet.sections[0]));

  // ---- followups: financial fields are RBAC-scoped ----
  const asOwner = await CTX.assemble('followups');
  const ownerQuoteItem = asOwner.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('owner sees the quote total in followups', asOwner.ok && ownerQuoteItem.data.total === 1500);
  cfg.set({ role: 'crew' });
  const asCrew = await CTX.assemble('followups');
  const crewQuoteItem = asCrew.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('crew packet carries NO financial fields', asCrew.ok && crewQuoteItem && !('total' in crewQuoteItem.data));
  t.eq('crew packet declares its role', asCrew.packet.role, 'crew');
  // attention gates the quote total on the SAME RBAC check
  const attCrew = await CTX.assemble('attention_today');
  const attCrewQuote = attCrew.packet.sections[0].items.find((i) => i.sourceRef.collection === 'quotes');
  t.ok('crew sees NO quote total in attention either', attCrew.ok && attCrewQuote && !('total' in attCrewQuote.data));
  cfg.set({ role: 'owner' });
  t.ok('owner still sees the quote total in attention', quoteAtt.data.total === 1500);

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
  t.ok('phone/email planted inside the note free text are masked',
    custItem.data.note.includes('[redacted]') && !/\d{7,}/.test(custItem.data.note.replace(/[\s().-]/g, '')) && !custItem.data.note.includes('mg@x.com'));
  t.ok('the packet declares the free-text scrub', dctx.packet.redactions.indexOf('freeText.phone') !== -1 && dctx.packet.redactions.indexOf('freeText.email') !== -1);
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

  // ===== scrub precision: contact PII masks, scheduling/reference data survives =====
  await data.put('customers', 'cust_scrub', { id: 'cust_scrub', name: 'S', phone: '1', notes: 'reschedule to 2026-07-15 re quote_2026070901, call 713-555-0142 or 7135550142', preferredChannel: 'sms', workspaceId: 'ws_test' });
  const scrubQuote = await Q.createDraft({ estimate: { quote: { _laborTotal: 10, _materialTotal: 5, total: 100 }, receipt: { total: 100 } }, customerId: 'cust_scrub' });
  const scrubCtx = await CTX.assemble('draft_followup', { quoteId: scrubQuote.id });
  const scrubNote = scrubCtx.packet.sections[0].items.find((i) => i.sourceRef.collection === 'customers').data.note;
  t.ok('phone numbers still mask (dashed and bare)', scrubNote.indexOf('713-555-0142') === -1 && scrubNote.indexOf('7135550142') === -1);
  t.ok('ISO dates survive the scrub', scrubNote.indexOf('2026-07-15') !== -1);
  t.ok('record ids survive the scrub', scrubNote.indexOf('quote_2026070901') !== -1);

  return t.report();
};
