/*
 * Audit Ledger — append-only, hash-chained, tamper-evident record (no network).
 *
 * Verifies: genesis linkage, sequential seq, prevHash chaining, a clean chain
 * verifies ok, content tampering is detected at the right index, and records
 * are frozen (immutable in memory).
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('audit-ledger');
  const { G, data } = setupEnv({});
  load('js/governance/audit-ledger.js');
  const L = G.AAA_AUDIT_LEDGER;

  // ---- append + chaining --------------------------------------------------
  const a = await L.append('flagged', { caseId: 'c1', verdict: 'unsafe' });
  const b = await L.append('override_approved', { caseId: 'c1', reason: 'looks fine' });
  const c = await L.append('sent', { caseId: 'c1' });

  t.ok('first seq is 0', a.seq === 0);
  t.ok('genesis prevHash', a.prevHash === L.GENESIS);
  t.ok('seq increments', b.seq === 1 && c.seq === 2);
  t.ok('prevHash links to prior hash', b.prevHash === a.hash && c.prevHash === b.hash);
  t.ok('hash is 16 hex chars', /^[0-9a-f]{16}$/.test(a.hash));
  t.ok('records are frozen', Object.isFrozen(a));

  // mutating a frozen record does not change it (immutability)
  try { a.payload.verdict = 'safe'; } catch (_) {}
  t.ok('frozen record unchanged after mutation attempt', a.payload.verdict === 'unsafe');

  // ---- verify clean chain -------------------------------------------------
  let v = await L.verify();
  t.ok('clean chain verifies ok', v.ok === true && v.length === 3);

  // ---- tamper detection ---------------------------------------------------
  // Simulate someone editing the stored record directly in the data layer
  // (bypassing append). The hash no longer matches its content.
  const tampered = Object.assign({}, b, { payload: { caseId: 'c1', reason: 'TAMPERED' } });
  await data.put('governance_audit', b.id, tampered);
  v = await L.verify();
  t.ok('tampering detected', v.ok === false);
  t.eq('tamper flagged at the edited index', v.brokenAt, 1);
  t.eq('reason is content tamper', v.reason, 'CONTENT_TAMPERED');

  // ---- hashEntry is deterministic & order-independent ---------------------
  const h1 = L.hashEntry({ a: 1, b: 2, payload: { x: 1, y: 2 } });
  const h2 = L.hashEntry({ b: 2, a: 1, payload: { y: 2, x: 1 } });
  t.eq('hash is canonical (key-order independent)', h1, h2);
  t.ok('different content → different hash', L.hashEntry({ a: 1 }) !== L.hashEntry({ a: 2 }));

  return t.report();
};
