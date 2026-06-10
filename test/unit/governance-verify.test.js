/*
 * Server-side SHA-256 ledger re-verification (Netlify function, no network).
 * Cross-implementation check: a chain built client-side (WebCrypto SHA-256) is
 * re-verified server-side (Node crypto) — proving the digests match — and
 * tampering / chain breaks / missing sha are detected.
 */
'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance-verify');
  const { G } = setupEnv({});
  load('js/governance/audit-ledger.js');
  const L = G.AAA_AUDIT_LEDGER;
  const lib = await import(path.join(ROOT, 'netlify/functions/governance-verify.mjs'));

  // Build a real chain with the client (WebCrypto), verify on the server (Node crypto).
  await L.append('flagged', { caseId: 'c1', verdict: 'unsafe' });
  await L.append('override_approved', { caseId: 'c1', reason: 'looks fine' });
  await L.append('sent', { caseId: 'c1' });
  const chain = await L.chain();

  const ok = lib.verifyShaChain(chain);
  t.ok('server re-verifies a valid chain', ok.ok === true && ok.length === 3);
  t.ok('client + server SHA-256 agree (cross-impl)', ok.ok === true);

  // canonical() must be byte-identical across client and server
  t.eq('canonical matches client', lib.canonical({ b: 2, a: 1, p: { y: 2, x: 1 } }), L.canonical({ a: 1, b: 2, p: { x: 1, y: 2 } }));

  // tampered content → server detects SHA mismatch
  const tampered = chain.map((e, i) => i === 1 ? Object.assign({}, e, { payload: { caseId: 'HACKED' } }) : e);
  const bad = lib.verifyShaChain(tampered);
  t.ok('server detects content tampering', bad.ok === false && bad.reason === 'SHA_TAMPERED' && bad.brokenAt === 1);

  // broken chain linkage → server detects
  const relinked = chain.map((e, i) => i === 2 ? Object.assign({}, e, { prevSha: 'deadbeef' }) : e);
  t.ok('server detects broken chain linkage', lib.verifyShaChain(relinked).reason === 'PREV_SHA_MISMATCH');

  // missing sha → NO_SHA
  const nosha = chain.map((e, i) => i === 0 ? Object.assign({}, e, { sha: null }) : e);
  t.eq('server flags entries without sha', lib.verifyShaChain(nosha).reason, 'NO_SHA');

  // empty input is trivially ok
  t.ok('empty chain ok', lib.verifyShaChain([]).ok === true);

  return t.report();
};
