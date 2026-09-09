/* Money, persistence, revision and approval boundaries for the connected builder. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
module.exports = async function () {
  const t = makeRunner('quote-builder');
  const { G, cfg, data } = setupEnv();
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js', 'js/quotes/integrations/measurement-to-quote.js', 'js/quotes/quote-store.js', 'js/quotes/quote-builder.js'].forEach(load);
  const B = G.AAA_QUOTE_BUILDER, Q = G.AAA_QUOTES;
  const draft = (lines) => Object.assign(B.fresh(), { customer: { name: 'Test Customer', phone: '(713) 555-0123', email: 'test@example.com' }, lines: lines });
  const clean = () => draft([{ serviceId: 'carpet_shampoo', rooms: 3 }]);
  const p = B.preview(clean());
  t.eq('three cleaning rooms use $45 baseline', p.estimate.quote.total, 135);
  const combined = B.preview(draft([{ serviceId: 'carpet_shampoo', rooms: 1 }, { serviceId: 'stairs', stairsCount: 2 }]));
  t.eq('combined small services incur one trip minimum', combined.estimate.quote.total, 95);
  t.eq('stairs preserve 1.5x labor multiplier', combined.estimate.quote.lines[1].subtotal, 18);
  t.eq('one explicit minimum adjustment', combined.estimate.quote.lines.filter((l) => l.serviceId === 'minimum').length, 1);
  t.eq('receipt sum equals total', combined.estimate.receipt.items.reduce((n, l) => n + Math.round(l.amount * 100), 0), 9500);
  const install = draft([{ serviceId: 'carpet_install', length: '10', width: '12', carpetName: 'Selected carpet', materialRate: '2', padRate: '0.5' }]);
  install.rateSnapshot.min_job = 0;
  t.eq('installation uses area, selected material and allowance', B.preview(install).estimate.quote.total, 420);
  for (const key of ['materialRate', 'padRate']) {
    const blank = JSON.parse(JSON.stringify(install)); blank.lines[0][key] = '';
    const result = B.preview(blank);
    t.eq('cleared ' + key + ' must not silently use a default price', result.ok, false);
    t.ok('cleared material price explains what is missing', /price is required/.test(result.message));
    blank.lines[0][key] = 0;
    t.eq('explicit zero ' + key + ' is allowed for customer-supplied material', B.preview(blank).ok, true);
  }
  const missingRooms = clean(); missingRooms.lines[0].rooms = '';
  t.eq('cleared room count is required instead of silently becoming one', B.preview(missingRooms).ok, false);
  const belowFloor = clean(); belowFloor.rateSnapshot.shampoo_min_per_room = 1;
  t.eq('displayed cleaning rate cannot disagree with the enforced floor', B.preview(belowFloor).ok, false);
  const cleared = B.preview(install).input;
  cleared.lines[0].length = ''; cleared.lines[0].width = '';
  t.eq('cleared dimensions cannot reuse a stale calculated area', B.preview(cleared).ok, false);
  const manual = draft([{ serviceId: 'manual', description: 'Patch work', quantity: 3, unitPrice: 33.33 }]);
  t.eq('manual decimal totals calculated in cents', B.preview(manual).estimate.quote.total, 99.99);
  const imported = B.fromMeasurements([{ roomName: 'Living', squareFeet: 120 }, { roomName: 'Stairs', stairsCount: 10 }], ['carpet_install'], { customer: { name: 'Measured customer' } });
  t.eq('measurement import selects applicable measurements per service', imported.lines.length, 2);
  t.eq('measured stairs are carried as a separately charged service', imported.lines[1].serviceId, 'stairs');
  t.eq('imported mixed measurements produce a valid quote', B.preview(imported).ok, true);
  G.AAA_MEASUREMENT_STORE = { getSession: async (id) => ({ id: id, squareFeet: 100, workspaceId: 'ws_test' }), listSessions: async () => { throw new Error('Unexpected unscoped measurement lookup'); } };
  t.eq('jobless quote never reads all previous measurements', (await B.scopedMeasurements({})).length, 0);
  t.eq('jobless quote uses only captured IDs', (await B.scopedMeasurements({ sessionIds: ['this-room'] }))[0].id, 'this-room');
  G.AAA_FIELD_CAPTURE_SESSION = { rooms: async (id) => [{ id: id + '-live' }, { id: 'deleted', deleted: true }, { id: 'foreign', workspaceId: 'another' }] };
  const scoped = await B.scopedMeasurements({ fieldSessionId: 'this-capture' });
  t.eq('field session excludes deleted and other-workspace rooms', scoped.length, 1);
  t.eq('field session uses its own captured rooms', scoped[0].id, 'this-capture-live');
  for (const v of [-1, Infinity, NaN, 'nope', true, {}, []]) {
    const bad = clean(); bad.lines[0].rooms = v;
    t.eq('reject invalid room quantity ' + String(v), B.preview(bad).ok, false);
  }
  for (const line of [{ serviceId: 'carpet_install', length: 10 }, { serviceId: 'carpet_stretch' }, { serviceId: 'carpet_repair' }, { serviceId: 'stairs', stairsCount: 1.5 }, { serviceId: '__proto__' }, { serviceId: 'manual', quantity: 1, unitPrice: -5 }]) {
    t.eq('reject invalid service data ' + line.serviceId, B.preview(draft([line])).ok, false);
  }
  const invalidRate = clean(); invalidRate.rateSnapshot.min_job = -1;
  t.eq('negative rate cannot price a draft', B.preview(invalidRate).ok, false);
  invalidRate.rateSnapshot.min_job = 95; invalidRate.rateSnapshot.range_spread = 2;
  t.eq('invalid percentage rejected', B.preview(invalidRate).ok, false);
  const unknown = clean(); unknown.version = 999;
  t.eq('unknown contract versions rejected', B.preview(unknown).error, 'UNSUPPORTED_VERSION');
  cfg.set({ rateCard: { shampoo_min_per_room: 80 } });
  t.eq('a saved rate snapshot does not drift with config changes', B.preview(p.input).estimate.quote.total, 135);
  cfg.set({ rateCard: {} });

  const saved = await B.save(clean(), { actor: 'owner' });
  t.ok('save creates real draft without a job', saved.ok && saved.quote.status === 'draft' && !saved.quote.jobId);
  t.eq('quote starts at revision 1', saved.quote.revision, 1);
  t.eq('selling rates are not presented as actual cost', saved.quote.internalCost.total, null);
  t.eq('unknown margin stays unknown', saved.quote.marginPct, null);
  const id = saved.quote.id;
  t.eq('share before review is blocked', (await B.prepareShare(id, { expectedRevision: 1 })).error, 'NEEDS_REVIEW');
  t.eq('AI cannot review', (await Q.markReviewed(id, { origin: 'ai', expectedRevision: 1, confirmRates: true })).error, 'AI_NOT_PERMITTED');
  t.eq('review requires an explicit rate confirmation', (await Q.markReviewed(id, { actor: 'owner', expectedRevision: 1 })).ok, false);
  G.AAA_RBAC.setRole('crew');
  t.eq('crew cannot approve a quote', (await Q.markReviewed(id, { expectedRevision: 1, confirmRates: true })).ok, false);
  G.AAA_RBAC.setRole('owner');
  const reviewed = await Q.markReviewed(id, { actor: 'owner', expectedRevision: 1, confirmRates: true });
  t.eq('owner review advances revision', reviewed.quote.revision, 2);
  const share = await B.prepareShare(id, { expectedRevision: 2 });
  t.ok('share prepares encoded SMS and email drafts', share.smsUrl.startsWith('sms:7135550123?body=') && share.emailUrl.startsWith('mailto:test%40example.com?'));
  t.ok('customer text hides internal labor, waste and cost', !/internalCost|margin|waste|_labor|rateSnapshot/i.test(share.text));
  t.eq('preparing a share does not mark it sent', (await Q.get(id)).status, 'reviewed');
  t.eq('AI cannot prepare customer sharing', (await B.prepareShare(id, { expectedRevision: 2, origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  t.eq('send requires actual-send confirmation', (await Q.send(id, { expectedRevision: 2 })).error, 'DELIVERY_CONFIRMATION_REQUIRED');

  const edited = clean(); edited.lines[0].rooms = 4;
  const edit = await B.save(edited, { id: id, expectedRevision: 2, actor: 'owner' });
  t.ok('editing preserves identity and requires fresh review', edit.ok && edit.quote.id === id && edit.quote.status === 'draft' && !edit.quote.review.reviewedAt);
  t.eq('edited total recalculated', edit.quote.customerTotal, 180);
  t.eq('stale share blocked', (await B.prepareShare(id, { expectedRevision: 2 })).error, 'REVISION_CONFLICT');
  t.eq('stale edit blocked', (await B.save(clean(), { id: id, expectedRevision: 2 })).error, 'REVISION_CONFLICT');
  const attempts = await Promise.all([B.save(clean(), { id: id, expectedRevision: 3 }), B.save(edited, { id: id, expectedRevision: 3 })]);
  t.eq('competing edits do not silently overwrite in one runtime', attempts.filter((r) => r.ok).length, 1);
  const q4 = await Q.get(id);
  const reapprove = await Q.markReviewed(id, { expectedRevision: q4.revision, confirmRates: true });
  const sent = await Q.send(id, { expectedRevision: reapprove.quote.revision, confirmedSent: true, actor: 'owner' });
  t.eq('confirmed send records sent', sent.quote.status, 'sent');
  t.eq('sent quote cannot be rewritten', (await B.save(edited, { id: id, expectedRevision: sent.quote.revision })).error, 'QUOTE_LOCKED');
  t.eq('negative actual cost blocked', (await Q.markWon(id, { expectedRevision: sent.quote.revision, reason: 'approved', jobCost: -10 })).error, 'INVALID_AMOUNT');
  const won = await Q.markWon(id, { expectedRevision: sent.quote.revision, actor: 'owner', reason: 'scope accepted', jobCost: '' });
  t.ok('record outcome without inventing job cost', won.ok && won.quote.jobCost === null && won.quote.grossMargin === null);
  t.eq('outcome is linked to this quote', (await data.list('outcomes')).filter((o) => o.quoteId === id).length, 1);
  t.ok('no invoice or payment created by quoting', !data._store.invoices && !data._store.payments);

  const proposal = await B.propose(clean(), { actor: 'future-agent' });
  t.ok('agent can create separate draft', proposal.ok && proposal.quote.status === 'draft');
  t.eq('agent cannot revise a business quote', (await B.save(clean(), { id: proposal.quote.id, expectedRevision: 1, origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  t.eq('agent cannot invent a manual price', (await B.propose(manual)).error, 'AI_PRICE_OVERRIDE_NOT_ALLOWED');
  const low = clean(); low.rateSnapshot.shampoo_min_per_room = 1;
  t.eq('agent supplied rate snapshot is ignored', (await B.propose(low)).quote.customerTotal, 135);
  t.ok('draft creation has an audit entry', (await data.list('audit_log')).some((a) => a.action === 'CREATE_QUOTE_DRAFT' && a.decision === 'allowed'));
  cfg.set({ workspaceId: 'other-workspace' });
  t.eq('quote lookup is workspace-scoped', await Q.get(id), null);
  cfg.set({ workspaceId: 'ws_test' });

  // Real device persistence, reload and rollback on quota errors.
  const backing = new Map(); let broken = false;
  G.localStorage = { get length() { return backing.size; }, key: (i) => [...backing.keys()][i], getItem: (k) => backing.get(k) || null,
    setItem(k, v) { if (broken) throw new Error('quota exceeded'); backing.set(k, v); } };
  load('js/core/local-first-storage.js');
  const local = G.AAA_LOCAL_FIRST_STORAGE;
  await local.boot();
  await B.saveWorking({ input: clean() });
  await local.boot();
  t.eq('unfinished work survives reload', (await B.loadWorking()).input.customer.name, 'Test Customer');
  cfg.set({ workspaceId: 'different' });
  t.eq('working copy does not cross workspaces', await B.loadWorking(), null);
  cfg.set({ workspaceId: 'ws_test' });
  const firstForm = Object.assign(clean(), { customer: { name: 'Unfinished first customer' } });
  await local.put('quote_builder_working', 'ws_test', { workspaceId: 'ws_test', value: { input: firstForm, dirty: true } }, { requirePersistent: true });
  await B.saveWorking({ workingKey: 'first', input: firstForm, dirty: true });
  t.eq('upgrading from the old single-slot format preserves unfinished work', (await B.loadWorking('legacy')).input.customer.name, 'Unfinished first customer');
  await B.saveWorking({ workingKey: 'second', input: edited, dirty: true });
  await local.boot();
  t.eq('switching forms preserves the first unfinished customer', (await B.loadWorking('first')).input.customer.name, 'Unfinished first customer');
  t.eq('latest form pointer restores the active form', (await B.loadWorking()).workingKey, 'second');
  t.ok('unfinished forms are discoverable for recovery', (await B.listWorking()).some((form) => form.key === 'first'));
  await B.saveWorking({ workingKey: 'second', input: edited, dirty: false });
  t.eq('clean saved forms are excluded from unfinished work', (await B.listWorking()).some((form) => form.key === 'second'), false);
  cfg.set({ workspaceId: 'different' });
  t.eq('recovery list does not cross workspaces', (await B.listWorking()).length, 0);
  cfg.set({ workspaceId: 'ws_test' });
  data.put = (collection, key, value, opts) => local.put(collection, key, value, opts);
  data.get = (collection, key) => local.get(collection, key);
  data.list = (collection) => local.getAll(collection);
  const durable = await B.save(clean());
  await local.boot();
  t.eq('saved quote survives reload', (await Q.get(durable.quote.id)).customerTotal, 135);
  broken = true;
  const oldWarn = console.warn; console.warn = () => {};
  const failed = await B.save(edited, { id: durable.quote.id, expectedRevision: 1 });
  console.warn = oldWarn;
  t.eq('quota failure is not reported as saved', failed.ok, false);
  t.eq('failed edit rolls back memory total', (await Q.get(durable.quote.id)).customerTotal, 135);
  t.eq('failed edit rolls back revision', (await Q.get(durable.quote.id)).revision, 1);
  broken = false;
  await local.boot();
  t.eq('failed edit left stored bytes unchanged', (await Q.get(durable.quote.id)).customerTotal, 135);
  const ready = await Q.markReviewed(durable.quote.id, { expectedRevision: 1, confirmRates: true });
  const delivered = await Q.send(durable.quote.id, { expectedRevision: ready.quote.revision, confirmedSent: true });
  broken = true; console.warn = () => {};
  const failedWon = await Q.markWon(durable.quote.id, { expectedRevision: delivered.quote.revision, reason: 'accepted' });
  console.warn = oldWarn;
  t.eq('unsaved won status is reported as failure', failedWon.ok, false);
  t.eq('failed won save creates no outcome signal', (await data.list('outcomes')).length, 0);
  broken = false;
  // A stalled remote backup must not hold the field workflow hostage.
  const mirrors = []; let finishFirstMirror;
  data.cloudReady = () => true;
  G.AAA_CLOUD = {
    insertEvent: () => new Promise(() => {}),
    upsertEntity: (collection, key, record) => {
      mirrors.push({ collection, key, record });
      if (collection === 'quotes' && !finishFirstMirror) return new Promise((resolve) => { finishFirstMirror = resolve; });
      if (collection === 'agent_decisions') return new Promise(() => {});
      return Promise.resolve();
    }
  };
  async function bounded(task) {
    let timer;
    try { return await Promise.race([task, new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'REMOTE_BLOCKED_LOCAL_SAVE' }), 250); })]); }
    finally { clearTimeout(timer); }
  }
  load('js/agents/supervisor.js');
  const offlineInput = clean(); offlineInput.jobId = 'job-with-slow-backup';
  await data.put('agent_decisions', 'decision-with-slow-backup', { id: 'decision-with-slow-backup', jobId: offlineInput.jobId, confidence: 80 });
  const offlineDraft = await bounded(B.save(offlineInput));
  t.ok('draft save completes while remote quote and audit mirrors hang', offlineDraft.ok);
  if (offlineDraft.ok) {
    const offlineReview = await bounded(Q.markReviewed(offlineDraft.quote.id, { expectedRevision: 1, confirmRates: true }));
    t.ok('human approval completes while cloud backup hangs', offlineReview.ok);
    if (offlineReview.ok) {
      const offlineSend = await bounded(Q.send(offlineDraft.quote.id, { expectedRevision: 2, confirmedSent: true }));
      t.ok('send recording completes while cloud backup hangs', offlineSend.ok);
      t.eq('new revisions wait behind the first cloud snapshot', mirrors.filter((m) => m.collection === 'quotes').length, 1);
      finishFirstMirror();
      await Promise.resolve(); await Promise.resolve();
      const pushed = mirrors.filter((m) => m.collection === 'quotes');
      t.eq('pending cloud updates coalesce to the latest saved revision', pushed[pushed.length - 1].record.revision, 3);
      t.eq('initial cloud snapshot cannot be mutated by later local changes', pushed[0].record.status, 'draft');
      t.ok('audit records still persist locally before confirmation', (await data.list('audit_log')).length >= 3);
      const offlineWon = await bounded(Q.markWon(offlineDraft.quote.id, { expectedRevision: 3, reason: 'Customer accepted' }));
      t.ok('recording won does not wait for the supervisor cloud backup', offlineWon.ok);
      t.eq('won status is saved locally despite stalled cloud backup', (await Q.get(offlineDraft.quote.id)).status, 'won');
      t.ok('supervisor scoring still updates the local decision', (await data.get('agent_decisions', 'decision-with-slow-backup')).score != null);
    }
  }
  delete G.localStorage;
  return t.report();
};
