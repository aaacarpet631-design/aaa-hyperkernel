'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = async function () {
  const t = makeRunner('backup');
  const { handleBackup, COLLECTIONS } = await import(path.join(ROOT, 'netlify/lib/backup.mjs'));
  const { authorizeApp, boundedBody } = await import(path.join(ROOT, 'netlify/lib/app-auth.mjs'));
  const db = new Map(); let serial = 0, writes = 0, collision = false;
  const copy = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const store = {
    async get(k) { return copy(db.get(k)?.data || null); },
    async getWithMetadata(k) { return copy(db.get(k) || null); },
    async getMetadata(k) { return copy(db.get(k)); },
    async list({ prefix }) { return { blobs: [...db.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
    async setJSON(k, data, options) {
      if (collision && !k.startsWith('history/')) { collision = false; return { modified: false }; }
      const prev = db.get(k);
      if (options.onlyIfNew && prev || options.onlyIfMatch && prev?.etag !== options.onlyIfMatch) return { modified: false };
      db.set(k, { data: copy(data), metadata: options.metadata, etag: String(++serial) }); writes++; return { modified: true };
    }
  };
  const snapshot = { version: 2, workspaceId: 'ws_test', deviceId: 'device-12345', generation: 1, collections: Object.fromEntries(COLLECTIONS.map(c => [c, {}])), mutations: [{ mutationId: 'm1', workspaceId: 'ws_test' }] };
  snapshot.collections.quotes.q = { id: 'q', workspaceId: 'ws_test', revision: 1, customerTotal: 45 };
  const request = body => new Request('https://app/api/sync', { method: 'POST', body: JSON.stringify(body) });
  const call = async (body, userId = 'owner') => handleBackup(request(body), { userId, store });
  const first = await call(snapshot);
  t.eq('first private snapshot saved', first.status, 200);
  t.eq('only uploaded mutation ID acknowledged', (await first.json()).acceptedIds[0], 'm1');
  await call(snapshot);
  t.eq('exact retry is idempotent', writes, 1);
  t.eq('same generation cannot overwrite different content', (await call({ ...snapshot, mutations: [] })).status, 409);
  collision = true;
  t.eq('conditional write conflict is retried', (await call({ ...snapshot, generation: 2 })).status, 200);
  t.eq('late older snapshot cannot replace a newer backup', (await call(snapshot)).status, 409);
  await call({ ...snapshot, deviceId: 'device-67890' });
  const listing = async (user, ws = 'ws_test') => (await handleBackup(new Request('https://app/api/sync?workspace=' + ws), { userId: user, store })).json();
  t.eq('devices keep separate recoverable backups', (await listing('owner')).backups.length, 3);
  t.eq('different account cannot list another account’s backups', (await listing('other')).backups.length, 0);
  t.eq('workspace isolation enforced', (await listing('owner', 'other')).backups.length, 0);
  const invalid = copy(snapshot); invalid.collections.quotes.q.workspaceId = 'other';
  try { await call(invalid); t.ok('mixed workspace rejected', false); } catch (e) { t.eq('mixed workspace rejected before write', e.code, 'INVALID_RECORD'); }
  const polluted = copy(snapshot); polluted.collections.quotes = JSON.parse('{"__proto__":{"workspaceId":"ws_test"}}');
  try { await call(polluted); t.ok('prototype rejected', false); } catch (e) { t.eq('prototype keys rejected', e.code, 'INVALID_RECORD'); }
  db.set('state', { data: { customers: { secret: 'legacy' } } });
  t.eq('unattributed legacy global data never appears in private listings', (await listing('owner')).backups.length, 3);

  const env = { APP_ALLOWED_USER_IDS: 'owner', APP_AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public' };
  const authenticated = new Request('https://app/api/sync', { headers: { authorization: 'Bearer token' } });
  t.eq('app allowlist uses provider-verified identity', await authorizeApp(authenticated, { env, fetchImpl: async () => new Response('{"id":"owner"}') }), 'owner');
  try { await authorizeApp(authenticated, { env, fetchImpl: async () => new Response('{"id":"other"}') }); t.ok('other user denied', false); }
  catch (e) { t.eq('browser cannot claim allowlisted identity', e.code, 'APP_ACCESS_DENIED'); }
  try { await boundedBody(new Request('https://app', { method: 'POST', body: '123456' }), 5); t.ok('large streamed body must reject', false); }
  catch (e) { t.eq('size limit enforced without trusting content-length', e.code, 'REQUEST_TOO_LARGE'); }
  for (const name of ['sync', 'claude', 'vision', 'receipt-blob', 'receipt-ocr', 'transcribe', 'research', 'private-gpu', 'nemotron', 'transport-send', 'governance-alert']) {
    const handler = (await import(path.join(ROOT, 'netlify/functions/' + name + '.mjs'))).default;
    const response = await handler(new Request('https://app/api/' + name, { method: 'POST', body: '{}' }));
    t.ok(name + ' never performs anonymous provider or storage work', [401, 503].includes(response.status));
    t.eq(name + ' failures are not cached', response.headers.get('cache-control'), 'no-store');
  }

  const { G, data } = setupEnv();
  const disk = new Map();
  G.localStorage = { get length() { return disk.size; }, key: i => [...disk.keys()][i], getItem: k => disk.get(k) || null, setItem: (k, v) => disk.set(k, v) };
  G.AAA_CONFIG.firebaseProjectId = 'test';
  G.AAA_CONFIG.firebaseAuthToken = 'header.' + Buffer.from('{"sub":"owner"}').toString('base64url') + '.signature';
  G.AAA_RBAC = { can: () => true, role: () => 'owner' };
  load('js/core/local-first-storage.js'); load('js/core/sync-engine.js'); load('js/core/aaa-runtime-gateway.js');
  const S = G.AAA_LOCAL_FIRST_STORAGE; await S.boot();
  data.put = (c,k,v,o) => S.put(c,k,v,o); data.list = c => S.getAll(c);
  let E = G.AAA_SYNC_ENGINE; E.storage = S; E.scheduleFlush = () => {};
  const originalFetch = G.fetch;
  await S.put('quotes', 'q', { id: 'q', revision: 1, workspaceId: 'ws_test', customerTotal: 45 });
  await S.put('quotes', 'other', { id: 'other', workspaceId: 'other' });
  await S.put('config', 'token', { accessToken: 'never-back-this-up' });
  await S.queueMutation({ mutationId: 'old', workspaceId: 'ws_test', syncStatus: 'PENDING' });
  let sent;
  G.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    t.eq('backup sends the current app session', opts.headers.authorization, 'Bearer ' + G.AAA_CONFIG.firebaseAuthToken);
    t.eq('only current workspace quote included', Object.keys(sent.collections.quotes).join(), 'q');
    t.eq('credentials are never in the snapshot', JSON.stringify(sent).includes('never-back-this-up'), false);
    await S.queueMutation({ mutationId: 'new', workspaceId: 'ws_test', syncStatus: 'PENDING' });
    await S.put('quotes', 'q', { id: 'q', revision: 2, workspaceId: 'ws_test', customerTotal: 90 });
    return new Response(JSON.stringify({ ok: true, generation: sent.generation, acceptedIds: ['old'], savedAt: new Date().toISOString() }));
  };
  t.eq('upload succeeds despite new work during request', (await E.syncNow()).ok, true);
  t.eq('new work remains queued after acknowledgement', (await S.getMutations()).find(m => m.mutationId === 'new').syncStatus, 'PENDING');
  t.eq('newer quote is preserved locally', (await S.get('quotes', 'q')).customerTotal, 90);
  t.eq('status does not claim newer changes are backed up', E.status.state, 'pending');
  await S.boot(); load('js/core/sync-engine.js'); E = G.AAA_SYNC_ENGINE; E.storage = S; E.scheduleFlush = () => {};
  G.fetch = async (_, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ ok: true, generation: sent.generation, acceptedIds: sent.mutations.map(m => m.mutationId), savedAt: new Date().toISOString() })); };
  t.eq('pending backup resumes after reload', (await E.syncNow({ force: false })).ok, true);
  t.eq('reload backs up latest durable revision', sent.collections.quotes.q.revision, 2);
  t.eq('all acknowledged mutations retained and marked synced', (await S.getMutations()).filter(m => m.syncStatus === 'SYNCED').length, 2);
  let calls = 0; G.fetch = async () => { calls++; throw Error('should not upload'); };
  t.eq('unchanged state does not consume another upload', (await E.syncNow({ force: false })).unchanged, true);
  t.eq('no needless network call', calls, 0);
  await S.queueMutation({ mutationId: 'unconfirmed', workspaceId: 'ws_test', syncStatus: 'PENDING' });
  G.fetch = async () => new Response('{"ok":true,"acceptedIds":["unconfirmed"],"generation":999}');
  t.eq('malformed acknowledgement is not a success', (await E.syncNow()).ok, false);
  t.eq('malformed acknowledgement leaves pending mutation intact', (await S.getMutations()).find(m => m.mutationId === 'unconfirmed').syncStatus, 'PENDING');
  let restore = copy(snapshot); restore.collections.quotes.newquote = { id: 'newquote', revision: 1, workspaceId: 'ws_test', customerTotal: 150 };
  restore = await G.AAA_BACKUP_FORMAT.seal(restore);
  const corrupt = copy(restore); corrupt.collections.quotes.newquote.customerTotal = 999;
  t.eq('corrupted restore rejected before mutation', (await E.restore(corrupt)).ok, false);
  t.eq('corruption leaves missing records absent', await S.get('quotes', 'newquote'), null);
  t.eq('preview reports a conflict without overwriting', (await E.previewRestore(restore)).conflicts, 1);
  t.eq('restore completes', (await E.restore(restore)).ok, true);
  t.eq('restore keeps newer existing quote', (await S.get('quotes', 'q')).customerTotal, 90);
  t.eq('restore adds missing quote', (await S.get('quotes', 'newquote')).customerTotal, 150);
  t.eq('repeat restore is idempotent', (await E.restore(restore)).result.added, 0);
  t.eq('restore rejects another workspace', (await E.restore({ ...restore, workspaceId: 'other' })).error, 'INVALID_BACKUP');
  t.ok('incoming conflicting version stays recoverable', (await S.get('restore_archives', restore.checksum)).collections.quotes.q.customerTotal === 45);
  const exported = await E.exportSnapshot();
  t.ok('export has a verifiable checksum', !!(await G.AAA_BACKUP_FORMAT.verify(exported, 'ws_test')));
  const old = await handleBackup(new Request('https://app/api/sync?workspace=ws_test&device=device-12345&generation=1'), { userId: 'owner', store });
  t.eq('older confirmed cloud generation remains retrievable', (await old.json()).state.generation, 1);
  const interrupted = await G.AAA_BACKUP_FORMAT.seal({ version: 2, workspaceId: 'ws_test', exportedAt: new Date().toISOString(), collections: Object.assign(Object.fromEntries(COLLECTIONS.map(c => [c, {}])), {
    jobs: { restored_job: { id: 'restored_job', workspaceId: 'ws_test' } },
    customers: { restored_customer: { id: 'restored_customer', workspaceId: 'ws_test', name: 'Recovered' } }
  }) });
  const commit = S._commit;
  S._commit = function(name, ...args) { if (name === 'customers') throw new Error('Device quota reached'); return commit.call(this, name, ...args); };
  t.eq('interrupted restore is reported as a failure', (await E.restore(interrupted)).ok, false);
  t.ok('interrupted restore preserves its entire incoming archive', !!await S.get('restore_archives', interrupted.checksum));
  t.eq('unassociated existing customer quote survives interruption', (await S.get('quotes', 'q')).customerTotal, 90);
  S._commit = commit;
  t.eq('retry adds only the remaining missing customer', (await E.restore(interrupted)).result.added, 1);
  t.eq('retry does not duplicate already restored jobs', (await S.getAll('jobs')).filter(j => j.id === 'restored_job').length, 1);
  G.fetch = originalFetch; delete G.localStorage;
  return t.report();
};
