/* Transport store — no-send-without-review, queue, retry, fallback, bounce, dedup, audit. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('transport-store');
  const { G, data } = setupEnv({ config: { transportBackoffMin: 0, transportMaxAttempts: 2, transportDedupMin: 60 } });
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/transport/template-registry.js');
  load('js/transport/transport-store.js');
  const TX = G.AAA_TRANSPORT;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  const okProvider = (name) => ({ name: name || 'mock', send: async () => ({ ok: true, providerId: 'pid_' + Math.random().toString(36).slice(2, 6) }) });
  const failProvider = (name) => ({ name: name || 'boom', send: async () => { throw new Error('provider down'); } });
  const sms = (list) => ({ sms: list, email: [] });

  // --- draft (AI-allowed) ---
  const d = await TX.draft({ templateId: 'quote_ready', to: '+15551234567', vars: { customerName: 'Jane', quoteRange: '$1,200–$1,500' }, relatedType: 'quote', relatedId: 'q1', origin: 'ai', actor: 'estimator' });
  t.ok('AI can draft a message', d.ok === true && d.message.status === 'pending_approval');
  t.ok('draft rendered a customer-safe body (no cost words)', /Jane/.test(d.message.body) && !/labor|margin|cost/i.test(d.message.body));
  t.ok('draft history seeded', d.message.history.length === 1 && d.message.history[0].type === 'drafted');
  const id = d.message.id;

  // --- NO send without review: AI + crew blocked ---
  RB.setRole('owner');
  t.eq('AI cannot approve/send', (await TX.approve(id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot send (office-only)', (await TX.approve(id, { actor: 'crew' })).error, 'FORBIDDEN');
  t.eq('still pending after blocked attempts', (await TX.get(id)).status, 'pending_approval');
  RB.setRole('owner');

  // --- human approve → queued + audited ---
  const ap = await TX.approve(id, { actor: 'owner' });
  t.ok('owner approve ok → queued', ap.ok === true && (await TX.get(id)).status === 'queued');
  t.ok('approval audited (SEND_MESSAGE allowed)', (await GW.recentAudit(100)).some((a) => a.action === 'SEND_MESSAGE' && a.decision === 'allowed'));

  // --- queue processing (mock provider) → sent ---
  const p1 = await TX.processQueue({ providers: sms([okProvider('twilio')]) });
  t.ok('queue sent the approved message', p1.sent === 1);
  const m1 = await TX.get(id);
  t.ok('message marked sent with provider + id', m1.status === 'sent' && m1.provider === 'twilio' && m1.providerId && m1.sentAt);

  // --- retry logic: provider fails → retry → fail after maxAttempts ---
  const r = await TX.draft({ templateId: 'on_the_way', to: '+15550000001', vars: { customerName: 'Bob' } });
  await TX.approve(r.message.id, { actor: 'owner' });
  const ra = await TX.processQueue({ providers: sms([failProvider()]) });   // attempt 1 → retry
  t.ok('first failure schedules a retry', ra.sent === 0 && (await TX.get(r.message.id)).status === 'queued' && (await TX.get(r.message.id)).attempts === 1);
  const rb = await TX.processQueue({ providers: sms([failProvider()]) });   // attempt 2 → failed (max 2)
  const rm = await TX.get(r.message.id);
  t.ok('fails after max attempts', rb.failed === 1 && rm.status === 'failed' && rm.attempts === 2);
  t.ok('retry + failure recorded in immutable history', rm.history.some((h) => h.type === 'retry_scheduled') && rm.history.some((h) => h.type === 'failed'));

  // --- provider fallback: primary throws, fallback sends ---
  const f = await TX.draft({ templateId: 'review_request_24h', to: '+15550000002', vars: { customerName: 'Sue', reviewUrl: 'http://x' } });
  await TX.approve(f.message.id, { actor: 'owner' });
  const fp = await TX.processQueue({ providers: sms([failProvider('primary'), okProvider('backup')]) });
  const fm = await TX.get(f.message.id);
  t.ok('fallback provider delivered after primary failed', fp.sent === 1 && fm.status === 'sent' && fm.provider === 'backup');
  t.ok('primary failure noted in history before send', fm.history.some((h) => h.type === 'provider_error') && fm.history.some((h) => h.type === 'sent'));

  // --- bounce handling ---
  await TX.markBounced(id, 'invalid number');
  const bm = await TX.get(id);
  t.ok('bounce recorded', bm.status === 'bounced' && bm.bounceReason === 'invalid number' && bm.history.some((h) => h.type === 'bounced'));

  // --- duplicate-send prevention ---
  await TX.draft({ templateId: 'quote_reminder', to: '+15559999999', relatedId: 'q9' });
  const dup = await TX.draft({ templateId: 'quote_reminder', to: '+15559999999', relatedId: 'q9' });
  t.ok('duplicate draft flagged', dup.duplicate === true && dup.message.status === 'duplicate' && !!dup.message.duplicateOf);
  t.eq('duplicate blocked from sending without override', (await TX.approve(dup.message.id, { actor: 'owner' })).error, 'DUPLICATE');
  t.ok('duplicate sends with explicit override', (await TX.approve(dup.message.id, { actor: 'owner', overrideDuplicate: true })).ok === true);

  // --- immutable history grows, never rewrites the first event ---
  t.ok('history is append-only (drafted stays first)', (await TX.get(id)).history[0].type === 'drafted' && (await TX.get(id)).history.length >= 4);

  // --- delivery tracker ---
  const dl = await TX.draft({ templateId: 'job_completion', to: 'jane@example.com', channel: 'email', vars: { customerName: 'Jane' } });
  await TX.approve(dl.message.id, { actor: 'owner' });
  await TX.processQueue({ providers: { sms: [], email: [okProvider('sendgrid')] } });
  await TX.markDelivered(dl.message.id, { providerStatus: 'delivered' });
  t.eq('delivery tracked', (await TX.get(dl.message.id)).status, 'delivered');

  // --- stats ---
  const stats = await TX.stats();
  t.ok('stats summarize delivery', typeof stats.delivered === 'number' && typeof stats.failed === 'number' && typeof stats.pendingApproval === 'number');

  // --- no-provider guard ---
  const np = await TX.draft({ templateId: 'on_the_way', to: '+15550000003', vars: {} });
  await TX.approve(np.message.id, { actor: 'owner' });
  await TX.processQueue({ providers: { sms: [], email: [] } });
  t.eq('no provider → failed honestly', (await TX.get(np.message.id)).status, 'failed');

  return t.report();
};
