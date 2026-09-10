'use strict';
const path = require('path');
const crypto = require('crypto');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');
module.exports = async function () {
  const t = makeRunner('reliability-policy'); const { G } = setupEnv();
  load('js/core/backup-format.js'); load('js/quotes/quote-conflicts.js'); load('js/core/aaa-rbac.js'); load('js/ui/tools-home.js');
  const F = G.AAA_BACKUP_FORMAT;
  t.eq('canonical digest ignores object insertion order', await F.digest({b:2,a:1}), await F.digest({a:1,b:2}));
  for (const [label, value] of [['undefined property',{a:undefined}],['Date object',new Date()],['NaN',NaN],['sparse array',Array(1)],['prototype key',JSON.parse('{"__proto__":1}')]]) {
    try { await F.digest(value); t.ok(label + ' rejects', false); } catch (_) { t.ok(label + ' rejects', true); }
  }
  const base = { customer: { name: 'Base', phone: '123' }, lines: [{ rooms: 1 }], rateSnapshot: { min_job: 100 }, note: 'original' };
  const local = structuredClone(base), remote = structuredClone(base);
  local.customer.name = 'Local'; local.lines[0].rooms = 2; delete local.note;
  remote.customer.phone = '456'; remote.lines.unshift({ rooms: 3 });
  let merged = G.AAA_QUOTE_CONFLICTS.merge(base, local, remote);
  t.eq('disjoint customer edits merge automatically', merged.input.customer.phone, '456');
  t.eq('local customer edit survives merge', merged.input.customer.name, 'Local');
  t.eq('uncontested deletion stays deleted', Object.hasOwn(merged.input, 'note'), false);
  t.eq('inserted work lines create an explicit conflict', merged.conflicts.length, 1);
  t.eq('work line conflict does not match unrelated rooms by index', merged.conflicts[0].path.join(), 'lines');
  merged = G.AAA_QUOTE_CONFLICTS.merge(base, local, remote, { [merged.conflicts[0].id]: 'remote' });
  t.eq('explicit resolution retains the entire selected work scope', merged.input.lines.length, 2);
  t.eq('all conflicts must be resolved', merged.conflicts.length, 0);
  t.eq('merge never mutates the original local draft', local.lines.length, 1);
  G.AAA_QUOTE_BUILDER_UI = { open: () => 'opened' }; G.AAA_SCHEDULE_UI = { open() {} }; G.AAA_BACKUP_UI = { open() {} };
  t.eq('search finds the backup by recovery intent', G.AAA_TOOLS_HOME.available('restore')[0][0], 'backup');
  t.eq('tool launches the real editor', G.AAA_TOOLS_HOME.launch('quote'), 'opened');
  G.AAA_RBAC.setRole('crew');
  t.eq('crew never sees owner pricing or backup tools', G.AAA_TOOLS_HOME.available().length, 0);
  t.eq('launch rechecks permission after a role change', G.AAA_TOOLS_HOME.launch('quote').error, 'UNAVAILABLE');

  const { consumeBudget, validateJson, validateModelRequest } = await import(path.join(ROOT, 'netlify/lib/request-policy.mjs'));
  const db = new Map(); let serial = 0;
  const store = {
    async getWithMetadata(key) { return db.get(key) || null; },
    async setJSON(key, data, opts) {
      const old = db.get(key);
      if (opts.onlyIfNew && old || opts.onlyIfMatch && old?.etag !== opts.onlyIfMatch) return { modified: false };
      db.set(key, { data, etag: String(++serial) }); return { modified: true };
    }
  };
  const concurrent = await Promise.allSettled(Array.from({length:8}, () => consumeBudget(store, 'owner', 60000, 3)));
  t.eq('concurrent functions share one rate budget', concurrent.filter(r => r.status === 'fulfilled').length, 3);
  t.ok('exhausted rate budget returns 429', concurrent.filter(r => r.status === 'rejected').every(r => r.reason.status === 429));
  await consumeBudget(store, 'other', 60000, 3); await consumeBudget(store, 'owner', 120000, 3);
  t.eq('rate state is bounded to one key per account', db.size, 2);
  try { validateJson(JSON.parse('{"nested":{"__proto__":{}}}')); t.ok('nested unsafe key denied', false); } catch (e) { t.eq('nested unsafe key denied', e.code, 'INVALID_JSON_KEY'); }
  try { validateModelRequest({ messages: [{role:'user',content:'test'}], max_tokens: 999999 }); t.ok('unbounded output denied', false); } catch (e) { t.eq('unbounded output denied', e.code, 'INVALID_TOKEN_LIMIT'); }

  const { verifyWebhook } = await import(path.join(ROOT, 'netlify/lib/webhook-auth.mjs'));
  const url = 'https://app.example/api/transport-webhook?provider=twilio';
  const body = Buffer.from('MessageSid=SM123&MessageStatus=delivered');
  const token = 'test-only-provider-secret';
  const signature = crypto.createHmac('sha1', token).update(url + 'MessageSidSM123MessageStatusdelivered').digest('base64');
  const req = new Request(url, { headers: { 'x-twilio-signature': signature } });
  t.eq('valid Twilio signature accepted', verifyWebhook(req, body, {TWILIO_AUTH_TOKEN:token}), 'twilio');
  for (const [label, request, bytes] of [['changed body', req, Buffer.from('MessageSid=SM456&MessageStatus=delivered')], ['changed URL', new Request(url+'&changed=1', {headers:req.headers}), body]]) {
    try { verifyWebhook(request, bytes, {TWILIO_AUTH_TOKEN:token}); t.ok(label+' denied',false); } catch (e) { t.eq(label+' denied',e.code,'INVALID_WEBHOOK_SIGNATURE'); }
  }
  const pair = crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const raw = Buffer.from('[ {"event":"delivered","sg_message_id":"id"} ]');
  const timestamp = '1750000000';
  const env = { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: pair.publicKey.export({format:'der',type:'spki'}).toString('base64') };
  const sig = crypto.sign('sha256', Buffer.concat([Buffer.from(timestamp),raw]), pair.privateKey).toString('base64');
  const sg = new Request('https://app.example/api/transport-webhook?provider=sendgrid', {headers: {'x-twilio-email-event-webhook-timestamp':timestamp,'x-twilio-email-event-webhook-signature':sig}});
  t.eq('SendGrid signature validates original raw bytes', verifyWebhook(sg,raw,env,Number(timestamp)*1000),'sendgrid');
  try { verifyWebhook(sg,Buffer.from(JSON.stringify(JSON.parse(raw))),env,Number(timestamp)*1000); t.ok('modified raw body denied',false); } catch(e) { t.eq('modified raw body denied',e.code,'INVALID_WEBHOOK_SIGNATURE'); }
  try { verifyWebhook(sg,raw,env,Number(timestamp)*1000+301000); t.ok('stale callback denied',false); } catch(e) { t.eq('stale callback denied',e.code,'INVALID_WEBHOOK_TIMESTAMP'); }
  const webhook = (await import(path.join(ROOT,'netlify/functions/transport-webhook.mjs'))).default;
  t.ok('unsigned webhook cannot perform storage work', [403,503].includes((await webhook(new Request(url,{method:'POST',body}))).status));
  return t.report();
};
