/* Quote lifecycle store — transitions, audit, review gate, training signals, cost-hiding. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('quote-store');
  const { G, data } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/agents/estimator-agent.js');
  load('js/quotes/quote-store.js');
  const M = G.AAA_MEASUREMENT_MODELS;
  const E = G.AAA_ESTIMATOR;
  const Q = G.AAA_QUOTES;
  const GW = G.AAA_RUNTIME_GATEWAY;

  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', estimates: [], workspaceId: 'ws_test' });
  const sessions = [M.newSession({ roomName: 'Living', length: 14, width: 12 })];

  // --- AI Estimator writes a DRAFT quote record (the one AI-allowed write) ---
  const est = await E.draftQuote({ sessions: sessions, services: ['carpet_install'], jobId: 'j1', customerName: 'Jane', leadSource: 'google', zip: '77002', actor: 'estimator', origin: 'ai' });
  t.ok('estimator drafted a quote', est.ok === true && !!est.quoteId && est.quoteDraft.status === 'draft');
  const id = est.quoteId;
  let q = await Q.get(id);
  t.ok('draft has internal cost + margin', q.internalCost && q.internalCost.total >= 0 && q.marginEstimate != null && q.marginPct != null);
  t.ok('draft has customer receipt + scores', !!q.customerReceipt && q.confidence != null && q.risk != null);
  t.ok('draft status history seeded', q.statusHistory.length === 1 && q.statusHistory[0].status === 'draft');
  t.ok('draft captured lead source + zip', q.leadSource === 'google' && q.zip === '77002');

  // --- customer view hides ALL internal numbers ---
  const cv = Q.customerView(q);
  const cvStr = JSON.stringify(cv);
  t.ok('customer view has items + total', Array.isArray(cv.items) && cv.items.length >= 1 && cv.total > 0);
  t.ok('customer view hides labor/material/cost/margin', !/_labor|_material|internalCost|margin|labor|jobCost/i.test(cvStr));

  // --- review gate: cannot send before a human reviews ---
  t.eq('send blocked before review', (await Q.send(id, { actor: 'owner' })).error, 'NEEDS_REVIEW');

  // --- cannot win straight from draft (invalid transition) ---
  t.eq('cannot win from draft', (await Q.markWon(id, { actor: 'owner', reason: 'x', finalPrice: 100 })).error, 'INVALID_TRANSITION');

  // --- AI is hard-blocked from committing transitions ---
  const aiReview = await Q.markReviewed(id, { actor: 'estimator', origin: 'ai' });
  t.eq('AI cannot review/commit a quote', aiReview.error, 'AI_NOT_PERMITTED');
  t.eq('quote still draft after blocked AI attempt', (await Q.get(id)).status, 'draft');

  // --- human review → send (audited) ---
  t.ok('human review ok', (await Q.markReviewed(id, { actor: 'owner', notes: 'looks good' })).ok === true);
  t.eq('status reviewed', (await Q.get(id)).status, 'reviewed');
  const sent = await Q.send(id, { actor: 'owner' });
  t.ok('send ok after review', sent.ok === true);
  t.eq('status sent', (await Q.get(id)).status, 'sent');

  // --- audit trail for each committing transition ---
  const audits = await GW.recentAudit(200);
  t.ok('review audited (MODIFY_QUOTE allowed)', audits.some((a) => a.action === 'MODIFY_QUOTE' && a.decision === 'allowed'));
  t.ok('send audited (SEND_QUOTE allowed)', audits.some((a) => a.action === 'SEND_QUOTE' && a.decision === 'allowed'));
  t.ok('blocked AI attempt audited as denied', audits.some((a) => a.action === 'MODIFY_QUOTE' && a.decision === 'denied' && a.reason === 'AI_NOT_PERMITTED'));

  // --- mark WON → training signal + supervisor scoring, no accounting post ---
  t.eq('won requires a reason', (await Q.markWon(id, { actor: 'owner' })).error, 'REASON_REQUIRED');
  const won = await Q.markWon(id, { actor: 'owner', reason: 'best price + trust', finalPrice: 2200, jobCost: 1400 });
  t.ok('won ok', won.ok === true);
  q = await Q.get(id);
  t.eq('status won', q.status, 'won');
  t.ok('won records final price + job cost + gross margin', q.finalPrice === 2200 && q.jobCost === 1400 && q.grossMargin === 800);
  // training signal in shared outcomes (lean — no margin leak)
  const outcomes = await data.list('outcomes');
  const out = outcomes.find((o) => o.quoteId === id);
  t.ok('won wrote a training signal to outcomes', !!out && out.result === 'won' && out.finalAmount === 2200);
  t.ok('training signal carries learning fields, not margin', out.serviceType && out.leadSource === 'google' && out.zip === '77002' && out.reason && !('grossMargin' in out) && !('jobCost' in out));
  // supervisor scored the estimator's decision (closed loop)
  t.ok('supervisor scored the estimator decision', (await data.list('agent_decisions')).some((d) => d.agent === 'estimator' && typeof d.score === 'number'));
  t.ok('won audited (RESOLVE_QUOTE allowed)', (await GW.recentAudit(200)).some((a) => a.action === 'RESOLVE_QUOTE' && a.decision === 'allowed'));
  // NO accounting post happened from the quote lifecycle
  t.ok('quote lifecycle posted nothing to the books', !data._store.invoices && !data._store.payments && !data._store.expenses);

  // --- mark LOST path (separate quote) writes a lost training signal ---
  const est2 = await E.draftQuote({ sessions: sessions, services: ['carpet_shampoo'], jobId: 'j1', customerName: 'Bob', leadSource: 'referral', origin: 'human', actor: 'owner' });
  await Q.markReviewed(est2.quoteId, { actor: 'owner' });
  await Q.send(est2.quoteId, { actor: 'owner' });
  const lost = await Q.markLost(est2.quoteId, { actor: 'owner', reason: 'went with a cheaper competitor' });
  t.ok('lost ok', lost.ok === true && (await Q.get(est2.quoteId)).status === 'lost');
  const lostOut = (await data.list('outcomes')).find((o) => o.quoteId === est2.quoteId);
  t.ok('lost training signal recorded', lostOut && lostOut.result === 'lost' && lostOut.finalAmount === null && /competitor/.test(lostOut.reason));

  // --- supervisor note (advisory annotation) ---
  await Q.addSupervisorNote(id, { note: 'Strong margin; replicate this pitch.', qualityScore: 90, riskScore: 20, by: 'supervisor' });
  t.eq('supervisor note stored', (await Q.get(id)).supervisorNotes.length, 1);

  // --- link a receipt (cross-reference only, no posting) ---
  await Q.link(id, { receiptId: 'rcpt_9', invoiceId: 'inv_9' });
  q = await Q.get(id);
  t.ok('links recorded', q.linkedReceiptIds.indexOf('rcpt_9') !== -1 && q.invoiceId === 'inv_9');

  // --- stats ---
  const stats = await Q.stats();
  t.ok('stats close rate computed', stats.closeRatePct === 50 && stats.counts.won === 1 && stats.counts.lost === 1);
  t.ok('stats won revenue + margin', stats.wonRevenue === 2200 && stats.wonMargin === 800);

  // --- leadId: ties a quote to Lead OS / ad attribution (internal-only) ---
  t.ok('drafts without a leadId store null', q.leadId === null);
  const estIn = { quote: { _laborTotal: 100, _materialTotal: 50, total: 400 }, receipt: { items: [{ description: 'Repair', amount: 400 }], total: 400 } };
  const dLead = await Q.createDraft({ estimate: estIn, customerName: 'Cara', leadId: 'lead_777', leadSource: 'google_ads', actor: 'owner', origin: 'human' });
  t.eq('draft stores leadId', dLead.leadId, 'lead_777');
  const dLong = await Q.createDraft({ estimate: estIn, leadId: 'x'.repeat(80) });
  t.ok('leadId sanitized to string, max 64 chars', typeof dLong.leadId === 'string' && dLong.leadId.length === 64);
  const cvLead = Q.customerView(dLead);
  t.ok('customer view never exposes leadId', !('leadId' in cvLead) && JSON.stringify(cvLead).indexOf('lead_777') === -1);
  await Q.markReviewed(dLead.id, { actor: 'owner' });
  await Q.send(dLead.id, { actor: 'owner' });
  await Q.markWon(dLead.id, { actor: 'owner', reason: 'repeat customer', finalPrice: 400, jobCost: 150 });
  const leadOut = (await data.list('outcomes')).find((o) => o.quoteId === dLead.id);
  t.ok('won outcome carries leadId for the ads margin join', !!leadOut && leadOut.leadId === 'lead_777');
  t.ok('outcomes without a lead carry leadId null', (await data.list('outcomes')).find((o) => o.quoteId === id).leadId === null);

  return t.report();
};
