/*
 * Scheduled server-side ledger audit (Netlify function, no network).
 * Verifies the pure audit core: a valid chain passes, a tampered chain produces
 * a critical PII-free integrity alert, and the alert is well-formed.
 */
'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-ledger-audit');
  const { G } = setupEnv({});
  load('js/governance/audit-ledger.js');
  const L = G.AAA_AUDIT_LEDGER;
  const lib = await import(path.join(ROOT, 'netlify/functions/governance-ledger-audit.mjs'));

  await L.append('flagged', { caseId: 'c1' });
  await L.append('sent', { caseId: 'c1' });
  const chain = await L.chain();

  // valid chain → ok, no alert
  const good = lib.auditEntries(chain);
  t.ok('valid ledger passes the audit', good.ok === true && good.verified === true && !good.alert);

  // tampered chain → ok:false + a critical integrity alert
  const tampered = chain.map((e, i) => i === 1 ? Object.assign({}, e, { payload: { caseId: 'HACKED' } }) : e);
  const bad = lib.auditEntries(tampered);
  t.ok('tampered ledger fails the audit', bad.ok === false && !!bad.alert);
  t.eq('alert is a critical governance integrity alert', bad.alert.severity, 'critical');
  t.eq('alert category', bad.alert.category, 'audit_ledger');
  t.ok('alert detail names the break reason', /SHA-256/.test(bad.alert.detail) && /SHA_TAMPERED/.test(bad.alert.detail));
  t.ok('alert carries a recommended action', typeof bad.alert.recommendedAction === 'string' && bad.alert.recommendedAction.length > 0);

  // alert is PII-free (only governance metadata keys)
  const allowed = ['kind', 'domain', 'category', 'severity', 'priority', 'metric', 'value', 'threshold', 'count', 'affectedCaseIds', 'detail', 'recommendedAction'];
  t.ok('alert has no customer/PII fields', Object.keys(bad.alert).every((k) => allowed.indexOf(k) !== -1));

  // buildAlert directly
  const a = lib.buildAlert({ reason: 'PREV_SHA_MISMATCH', writerId: 'devB', brokenAt: 3 }, 10);
  t.ok('buildAlert formats writer + seq', /devB/.test(a.detail) && /seq 3/.test(a.detail) && a.count === 10);

  // empty ledger is trivially fine
  t.ok('empty ledger ok', lib.auditEntries([]).ok === true);

  return t.report();
};
