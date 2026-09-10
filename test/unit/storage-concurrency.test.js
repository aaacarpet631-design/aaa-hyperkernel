'use strict';
const fs = require('fs'), vm = require('vm');
const { makeRunner, srcPath } = require('../helpers/harness');

module.exports = async function () {
  const t = makeRunner('storage-concurrency');
  const disk = new Map(), locks = new Map(); let quota = false;
  const localStorage = { get length() { return disk.size; }, key: i => [...disk.keys()][i], getItem: k => disk.get(k) ?? null,
    setItem: (k, v) => { if (quota) throw Error('quota'); disk.set(k, v); } };
  const navigator = { locks: { request(name, callback) {
    const next = (locks.get(name) || Promise.resolve()).catch(() => {}).then(callback);
    locks.set(name, next); return next;
  } } };
  async function tab() {
    const ctx = vm.createContext({ localStorage, navigator, console });
    vm.runInContext(fs.readFileSync(srcPath('js/core/local-first-storage.js'), 'utf8'), ctx);
    await ctx.AAA_LOCAL_FIRST_STORAGE.boot(); return ctx.AAA_LOCAL_FIRST_STORAGE;
  }
  const a = await tab(), b = await tab();
  await Promise.all([a.put('jobs', 'a', { id: 'a' }), b.put('jobs', 'b', { id: 'b' })]);
  t.eq('two tabs preserve both new jobs', (await a.getAll('jobs')).length, 2);
  t.eq('already-open tab reads the other tab’s write', (await b.get('jobs', 'a')).id, 'a');
  await a.put('quotes', 'q', { id: 'q', revision: 1, total: 45 }, { requirePersistent: true, expectedRevision: 0 });
  const competing = await Promise.allSettled([
    a.put('quotes', 'q', { id: 'q', revision: 2, total: 50 }, { requirePersistent: true, expectedRevision: 1 }),
    b.put('quotes', 'q', { id: 'q', revision: 2, total: 90 }, { requirePersistent: true, expectedRevision: 1 })
  ]);
  t.eq('exactly one concurrent quote revision wins', competing.filter(r => r.status === 'fulfilled').length, 1);
  t.eq('losing tab receives actionable revision conflict', competing.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const fetched = await a.get('quotes', 'q'); fetched.total = 999;
  t.eq('editing a returned object cannot mutate saved data', (await a.get('quotes', 'q')).total, 50);
  await a.queueMutation({ mutationId: 'sent', syncStatus: 'PENDING' });
  await b.queueMutation({ mutationId: 'new', syncStatus: 'PENDING' });
  await a.acknowledgeMutations(['sent']);
  t.eq('acknowledgement preserves newly queued work', (await b.getMutations()).find(m => m.mutationId === 'new').syncStatus, 'PENDING');
  quota = true;
  try { await a.put('quotes', 'q', { revision: 3, total: 100 }, { requirePersistent: true, expectedRevision: 2 }); t.ok('quota must reject', false); }
  catch (e) { t.eq('quota failure visible', e.code, 'DEVICE_STORAGE_UNAVAILABLE'); }
  quota = false;
  t.eq('failed write does not advance durable revision', (await b.get('quotes', 'q')).revision, 2);
  quota = true;
  await a.put('jobs', 'unsaved', { id: 'unsaved' });
  t.eq('noncritical memory fallback remains readable', (await a.get('jobs', 'unsaved')).id, 'unsaved');
  quota = false;
  await b.put('jobs', 'from-other-tab', { id: 'from-other-tab' });
  await a.put('jobs', 'durable', { id: 'durable' }, { requirePersistent: true });
  t.ok('recovering a volatile write preserves the other tab’s new record', !!await b.get('jobs', 'from-other-tab'));
  disk.set('aaa:quotes', '{broken');
  try { await a.put('quotes', 'replacement', { revision: 1 }); t.ok('corrupt collection must reject', false); }
  catch (e) { t.eq('corrupt bytes cannot be silently overwritten', e.code, 'DEVICE_STORAGE_CORRUPT'); }
  t.eq('original damaged bytes preserved for recovery', disk.get('aaa:quotes'), '{broken');
  try { await a.put('jobs', '__proto__', { polluted: true }); t.ok('prototype key must reject', false); }
  catch (e) { t.eq('prototype mutation rejected', e.code, 'INVALID_STORAGE_KEY'); }
  return t.report();
};
