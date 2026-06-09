/*
 * Governance Integrity — combined on-device verification + self-audit (no network).
 * Verifies the combined check across FNV/SHA/HMAC layers, signed-vs-unsigned
 * reporting, and that a tampered ledger triggers a critical escalation.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-integrity');
  const { G, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1', governanceSigningKey: 'k-workspace', governanceEscalationCooldownMs: 1000 } });
  let T = 1000000;
  G.AAA_RUNTIME_CLOCK = { now: () => T, nowISO: () => new Date(T).toISOString() };
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  load('js/governance/governance-integrity.js');
  const L = G.AAA_AUDIT_LEDGER, I = G.AAA_GOVERNANCE_INTEGRITY, E = G.AAA_GOVERNANCE_ESCALATION;

  const a = await L.append('flagged', { caseId: 'c1' });
  await L.append('sent', { caseId: 'c1' });

  // ---- combined check on a healthy, signed ledger ------------------------
  let r = await I.check();
  t.ok('all layers verify', r.ok === true && r.fnv.ok && r.sha.ok && r.sig.ok);
  t.ok('reports signed + counts', r.signed === true && r.entries === 2 && r.writers === 1);

  // ---- self-audit on a healthy ledger raises nothing ---------------------
  const escBefore = (await E.list()).length;
  r = await I.selfAudit({});
  t.ok('healthy self-audit ok, no escalation', r.ok === true && (await E.list()).length === escBefore);

  // ---- tamper → check fails, self-audit escalates (critical) -------------
  await data.put('governance_audit', a.id, Object.assign({}, a, { payload: { caseId: 'HACKED' } }));
  r = await I.check();
  t.ok('tamper detected by combined check', r.ok === false && (r.reason === 'CONTENT_TAMPERED' || r.reason === 'BAD_SIGNATURE'));
  r = await I.selfAudit({});
  t.ok('self-audit on broken ledger escalates', r.ok === false);
  const escs = await E.list();
  t.ok('a critical ledger_integrity escalation was raised', escs.some((e) => e.kind === 'ledger_integrity' && e.severity === 'critical' && e.status === 'open'));

  // ---- without a signing key, signatures are reported as not-configured --
  const { G: G2, data: d2 } = setupEnv({ config: { role: 'owner' } });
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  load('js/governance/governance-integrity.js');
  await G2.AAA_AUDIT_LEDGER.append('flagged', { caseId: 'z' });
  const r2 = await G2.AAA_GOVERNANCE_INTEGRITY.check();
  t.ok('unsigned ledger still verifies (sig skipped)', r2.ok === true && r2.signed === false && r2.sig.skipped === true);

  return t.report();
};
