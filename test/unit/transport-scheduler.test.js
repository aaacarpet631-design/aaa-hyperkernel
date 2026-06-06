/* Transport scheduler — auto-draft review requests + missed-call ack (drafts only, idempotent). */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const NOW = Date.parse('2026-06-10T00:00:00Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

module.exports = async function run() {
  const t = makeRunner('transport-scheduler');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/transport/template-registry.js');
  load('js/transport/transport-store.js');
  load('js/transport/transport-scheduler.js');
  const TX = G.AAA_TRANSPORT;
  const SCH = G.AAA_TRANSPORT_SCHEDULER;

  await data.put('customers', 'c1', { id: 'c1', name: 'Jane', phone: '+15551112222' });
  await data.put('customers', 'c3', { id: 'c3', name: 'Sue', email: 'sue@example.com' });
  // Closed 2 days ago (→ 24h request due), closed 8 days ago (→ both due), closed today (neither),
  // open job (skip), closed but no contact (skip).
  await data.put('jobs', 'jA', { id: 'jA', currentState: 'CLOSED', customerId: 'c1', customerName: 'Jane', closedAt: ago(2) });
  await data.put('jobs', 'jB', { id: 'jB', currentState: 'CLOSED', customerId: 'c3', customerName: 'Sue', closedAt: ago(8) });
  await data.put('jobs', 'jC', { id: 'jC', currentState: 'CLOSED', customerId: 'c1', customerName: 'Jane', closedAt: ago(0) });
  await data.put('jobs', 'jOpen', { id: 'jOpen', currentState: 'IN_PROGRESS', customerId: 'c1', closedAt: ago(3) });
  await data.put('jobs', 'jNoContact', { id: 'jNoContact', currentState: 'CLOSED', customerId: 'cX', closedAt: ago(3) });

  // --- run the scheduler ---
  const r = await SCH.runReviewRequests({ now: NOW });
  t.ok('scheduler ran', r.ok === true);
  // jA → 24h request (1). jB → 24h request + 7d reminder (2). jC → none yet. = 3 drafts.
  t.eq('drafted the due review messages', r.drafted, 3);

  const msgs = await TX.list();
  const has = (jobId, tpl) => msgs.some((m) => m.relatedId === jobId && m.templateId === tpl);
  t.ok('jA got a 24h review request', has('jA', 'review_request_24h') && !has('jA', 'review_reminder_7d'));
  t.ok('jB got both the request and the 7d reminder', has('jB', 'review_request_24h') && has('jB', 'review_reminder_7d'));
  t.ok('jC (just closed) got nothing yet', !msgs.some((m) => m.relatedId === 'jC'));
  t.ok('open + no-contact jobs were skipped', !msgs.some((m) => m.relatedId === 'jOpen' || m.relatedId === 'jNoContact'));

  // --- governance: scheduled messages are DRAFTS pending approval, never sent ---
  t.ok('scheduled messages are pending_approval (not sent)', msgs.every((m) => m.status === 'pending_approval'));

  // --- idempotent: running again drafts nothing new ---
  const r2 = await SCH.runReviewRequests({ now: NOW });
  t.eq('re-running drafts nothing new', r2.drafted, 0);
  t.eq('still the same number of messages', (await TX.list()).length, 3);

  // --- missed-call acknowledgement (draft, idempotent) ---
  const mc = await SCH.acknowledgeMissedCall({ phone: '+15559998888', customerName: 'Lead' });
  t.ok('missed-call ack drafted (pending approval)', mc.ok === true && mc.message.status === 'pending_approval' && mc.message.templateId === 'missed_call_textback');
  const mc2 = await SCH.acknowledgeMissedCall({ phone: '+15559998888' });
  t.ok('same number not acknowledged twice in the window', mc2.duplicate === true);
  t.eq('missed-call ack needs a phone', (await SCH.acknowledgeMissedCall({})).error, 'NO_PHONE');

  return t.report();
};
