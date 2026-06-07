/*
 * Audit ledger — SHA-256 cryptographic chain + conflict-safe multi-writer lanes.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('audit-ledger-crypto');
  const { G, data } = setupEnv({});
  load('js/governance/audit-ledger.js');
  const L = G.AAA_AUDIT_LEDGER;

  // ---- SHA-256 chain on real appends -------------------------------------
  const a = await L.append('flagged', { caseId: 'c1' });
  const b = await L.append('override_approved', { caseId: 'c1' });
  t.ok('entries carry a 64-hex sha', /^[0-9a-f]{64}$/.test(a.sha) && /^[0-9a-f]{64}$/.test(b.sha));
  t.eq('first prevSha is genesis', a.prevSha, L.GENESIS_SHA);
  t.eq('sha chains to prior sha', b.prevSha, a.sha);
  t.ok('fnv + sha chains both verify', (await L.verify()).ok === true && (await L.verifySha()).ok === true);

  // tamper a stored entry's content → both chains catch it
  await data.put('governance_audit', b.id, Object.assign({}, b, { payload: { caseId: 'HACKED' } }));
  const fv = await L.verify(); const sv = await L.verifySha();
  t.ok('fnv chain detects tamper', fv.ok === false && fv.reason === 'CONTENT_TAMPERED');
  t.ok('sha chain detects tamper', sv.ok === false && sv.reason === 'SHA_TAMPERED' && sv.brokenAt === 1);
  await data.put('governance_audit', b.id, b); // restore

  // ---- conflict-safe multi-writer lanes ----------------------------------
  // Two devices append concurrently → distinct writerIds, independent lanes.
  async function mk(wid, writerSeq, seq, prevHash, prevSha, payload) {
    const base = { id: 'e_' + wid + '_' + writerSeq, seq: seq, writerId: wid, writerSeq: writerSeq, type: 'evt', at: '2026-01-01T00:00:00Z', payload: payload, prevHash: prevHash };
    const hash = L.hashEntry(base);
    const sha = await L.sha256(L.canonical(base) + '|' + prevSha);
    return Object.assign({}, base, { hash: hash, prevSha: prevSha, sha: sha });
  }
  // fresh store for clarity
  for (const k of Object.keys(data._store.governance_audit || {})) delete data._store.governance_audit[k];

  const a0 = await mk('devA', 0, 0, L.GENESIS, L.GENESIS_SHA, { n: 1 });
  const b0 = await mk('devB', 0, 1, L.GENESIS, L.GENESIS_SHA, { n: 2 }); // concurrent first entry, own lane
  const a1 = await mk('devA', 1, 2, a0.hash, a0.sha, { n: 3 });
  const b1 = await mk('devB', 1, 3, b0.hash, b0.sha, { n: 4 });
  for (const e of [a0, b0, a1, b1]) await data.put('governance_audit', e.id, e);

  t.eq('two interleaved writer lanes both valid (fnv)', (await L.verify()).ok, true);
  t.eq('two interleaved writer lanes both valid (sha)', (await L.verifySha()).ok, true);
  t.ok('no collision: same global ordering, separate lanes', a0.writerSeq === 0 && b0.writerSeq === 0 && a0.writerId !== b0.writerId);

  // tamper only devB's lane → detected, attributed to devB, devA stays valid
  await data.put('governance_audit', b1.id, Object.assign({}, b1, { payload: { n: 999 } }));
  const mv = await L.verify();
  t.ok('tamper isolated to the offending writer lane', mv.ok === false && mv.writerId === 'devB' && mv.brokenAt === 1);

  return t.report();
};
