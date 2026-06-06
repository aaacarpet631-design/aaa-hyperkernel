/* Transport delivery truth — provider-event normalization + applyStatusEvent + markFailed. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('transport-delivery');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/transport/template-registry.js');
  load('js/transport/transport-store.js');
  const TX = G.AAA_TRANSPORT;

  // --- normalization (pure) ---
  const tw = (s, extra) => TX.normalizeProviderEvent('twilio', Object.assign({ MessageSid: 'SM1', MessageStatus: s }, extra || {}));
  t.eq('twilio delivered → delivered', tw('delivered').status, 'delivered');
  t.eq('twilio undelivered → bounced', tw('undelivered').status, 'bounced');
  t.eq('twilio failed → failed', tw('failed').status, 'failed');
  t.eq('twilio sent (intermediate) → ignored', tw('sent').status, 'ignored');
  t.eq('twilio carries the provider id', tw('delivered').providerId, 'SM1');
  t.ok('twilio carries an error reason', tw('failed', { ErrorMessage: 'bad number' }).reason === 'bad number');
  const sg = (e, extra) => TX.normalizeProviderEvent('sendgrid', Object.assign({ sg_message_id: 'SG1', event: e }, extra || {}));
  t.eq('sendgrid delivered → delivered', sg('delivered').status, 'delivered');
  t.eq('sendgrid bounce → bounced', sg('bounce').status, 'bounced');
  t.eq('sendgrid dropped → failed', sg('dropped').status, 'failed');
  t.eq('sendgrid deferred → ignored', sg('deferred').status, 'ignored');

  // --- send a message so it has a providerId ---
  const okP = (pid) => ({ sms: [{ name: 'twilio', send: async () => ({ ok: true, providerId: pid }) }], email: [] });
  const d = await TX.draft({ templateId: 'on_the_way', to: '+15551112222', vars: { customerName: 'Jane' } });
  await TX.approve(d.message.id, { actor: 'owner' });
  await TX.processQueue({ providers: okP('PID1') });
  t.eq('message sent with provider id', (await TX.get(d.message.id)).providerId, 'PID1');

  // --- applyStatusEvent: by providerId, delivered ---
  const ev = TX.normalizeProviderEvent('twilio', { MessageSid: 'PID1', MessageStatus: 'delivered' });
  const r1 = await TX.applyStatusEvent(ev);
  t.ok('delivery webhook marked it delivered', r1.ok === true && (await TX.get(d.message.id)).status === 'delivered');
  t.ok('delivery recorded in immutable history (source webhook)', (await TX.get(d.message.id)).history.some((h) => h.type === 'delivered' && h.source === 'webhook'));

  // --- idempotent + no-match + ignored ---
  t.ok('re-applying the same status is a noop', (await TX.applyStatusEvent(ev)).noop === true);
  t.eq('unknown provider id → no match', (await TX.applyStatusEvent({ providerId: 'NOPE', status: 'delivered' })).error, 'NO_MATCH');
  t.eq('ignored status is skipped', (await TX.applyStatusEvent({ status: 'ignored' })).error, 'IGNORED');

  // --- bounce via webhook ---
  const b = await TX.draft({ templateId: 'review_request_24h', to: 'bad@x.com', channel: 'email', vars: { customerName: 'Sue' } });
  await TX.approve(b.message.id, { actor: 'owner' });
  await TX.processQueue({ providers: { sms: [], email: [{ name: 'sendgrid', send: async () => ({ ok: true, providerId: 'PIDB' }) }] } });
  await TX.applyStatusEvent(TX.normalizeProviderEvent('sendgrid', { sg_message_id: 'PIDB', event: 'bounce', reason: 'mailbox full' }));
  const bm = await TX.get(b.message.id);
  t.ok('bounce webhook recorded', bm.status === 'bounced' && bm.bounceReason === 'mailbox full' && bm.history.some((h) => h.type === 'bounced'));

  // --- provider-reported failure (markFailed) ---
  const f = await TX.draft({ templateId: 'quote_reminder', to: '+15553334444' });
  await TX.approve(f.message.id, { actor: 'owner' });
  await TX.processQueue({ providers: okP('PIDF') });
  await TX.applyStatusEvent({ providerId: 'PIDF', status: 'failed', reason: 'carrier rejected' });
  const fm = await TX.get(f.message.id);
  t.ok('provider failure recorded', fm.status === 'failed' && fm.failureReason === 'carrier rejected' && fm.history.some((h) => h.type === 'failed' && h.source === 'provider'));

  // history is append-only (first event always 'drafted')
  t.eq('immutable history keeps drafted first', (await TX.get(d.message.id)).history[0].type, 'drafted');

  return t.report();
};
