/* Privacy & Data Governance — PII scan, AES-GCM vault, retention, export, governed erasure. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('privacy');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/aaa-privacy.js');
  const P = G.AAA_PRIVACY;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // seed customer data
  await data.put('customers', 'c1', { id: 'c1', name: 'Jane Doe', phone: '+15551112222', email: 'jane@example.com', address: '1 Main St' });
  await data.put('jobs', 'j1', { id: 'j1', workspaceId: 'ws_test', customerId: 'c1', customerName: 'Jane Doe', customerPhone: '+15551112222', address: '1 Main St', createdAt: '2026-01-01T00:00:00Z' });
  await data.put('quotes', 'q1', { id: 'q1', workspaceId: 'ws_test', customerId: 'c1', customerName: 'Jane Doe', createdAt: '2026-01-01T00:00:00Z' });
  await data.put('communications', 'm1', { id: 'm1', workspaceId: 'ws_test', customerId: 'c1', to: '+15551112222', body: 'Your quote is ready', createdAt: '2024-01-01T00:00:00Z' });

  // ===== PII classification + inventory =====
  const k = P.classify('customers', { name: 'Jane', phone: '', email: 'x@y.com' });
  t.ok('classify identifies present PII fields only', k.hasPII === true && k.piiFields.indexOf('name') !== -1 && k.piiFields.indexOf('email') !== -1 && k.piiFields.indexOf('phone') === -1);
  const scan = await P.scan();
  t.ok('scan inventories PII across collections', scan.ok === true && scan.totalPII >= 3 && scan.collections.some((c) => c.collection === 'customers' && c.withPII === 1));

  // ===== encrypted vault (AES-256-GCM round-trip) =====
  const sealed = await P.seal('secret-ssn-123');
  t.ok('seal encrypts (AES-GCM) with an IV + ciphertext', sealed.encrypted === true && !!sealed.iv && !!sealed.ct && !/secret-ssn/.test(sealed.ct));
  t.eq('open decrypts back to plaintext', await P.open(sealed), 'secret-ssn-123');
  const vp = await P.vaultPut('customer', 'c1', { ssn: '123-45-6789' });
  t.ok('vaultPut stores an encrypted blob', vp.ok === true && vp.encrypted === true);
  t.eq('vaultGet round-trips the object', (await P.vaultGet(vp.id)).ssn, '123-45-6789');
  const rawVault = (await data.list('privacy_vault'))[0];
  t.ok('vault at rest contains no plaintext', !/123-45-6789/.test(JSON.stringify(rawVault)));

  // ===== retention policies =====
  await P.setRetention('communications', 365, { actor: 'owner' });
  const rs = await P.retentionStatus(Date.parse('2026-06-01T00:00:00Z'));
  const comm = rs.categories.find((c) => c.category === 'communications');
  t.ok('retention status flags records past the window', comm.retentionDays === 365 && comm.expired === 1);
  t.ok('expiredRecords returns the stale rows', (await P.expiredRecords('communications', Date.parse('2026-06-01T00:00:00Z'))).some((r) => r.id === 'm1'));

  // ===== data export (portability / DSAR) =====
  const exp = await P.exportCustomer('c1');
  t.ok('export bundles the customer + linked records', exp.ok === true && exp.customer.id === 'c1' && exp.jobs.length === 1 && exp.quotes.length === 1 && exp.communications.length === 1);
  t.ok('export includes vault entries + a record count', exp.vault.length === 1 && exp.recordCount >= 4);
  t.eq('export of an unknown customer is honest', (await P.exportCustomer('')).error, 'NO_CUSTOMER');

  // ===== erasure workflow (request → approve → execute), governed =====
  const req = await P.requestErasure({ subjectType: 'customer', subjectId: 'c1', reason: 'customer request', actor: 'owner' });
  t.ok('erasure request is filed pending + audited', req.ok === true && req.request.status === 'pending' && !!req.request.auditRef);
  t.ok('request appears in the pending list', (await P.listRequests('pending')).some((r) => r.id === req.request.id));

  // AI cannot erase; crew cannot erase
  t.eq('AI cannot execute erasure', (await P.approveErasure(req.request.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot execute erasure (owner-only)', (await P.approveErasure(req.request.id, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');

  const done = await P.approveErasure(req.request.id, { actor: 'owner' });
  t.ok('owner executes erasure with a manifest', done.ok === true && done.request.status === 'executed' && done.request.manifest.length >= 1);
  // PII is redacted in place; record ids preserved (referential integrity)
  const c1after = await data.get('customers', 'c1');
  t.ok('customer PII redacted in place', c1after.id === 'c1' && c1after.name === P.REDACTED && c1after.phone === P.REDACTED && c1after.piiErased === true);
  t.eq('linked job PII redacted', (await data.get('jobs', 'j1')).customerName, P.REDACTED);
  t.ok('vault entry for the subject is dropped', (await P.vaultList('customer', 'c1')).every((v) => v.erased === true && v.ct == null));
  t.ok('a re-scan shows the customer PII gone', (await P.scan()).collections.find((c) => c.collection === 'customers').withPII === 0);

  // ===== access control + audit =====
  RB.setRole('manager');
  t.eq('manager cannot configure privacy (owner-only)', (await P.setRetention('quotes', 90, { actor: 'mgr' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const audit = await GW.recentAudit(200);
  t.ok('privacy + erasure actions are audited', audit.some((a) => a.action === 'MANAGE_PRIVACY' && a.decision === 'allowed') && audit.some((a) => a.action === 'ERASE_DATA' && a.decision === 'allowed'));

  return t.report();
};
