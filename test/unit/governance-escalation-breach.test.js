/*
 * Governance Escalation — condition-based breach lifecycle (no network).
 * Verifies raise, cooldown re-notify, acknowledge silencing, resolve, and that
 * a resolved breach RE-OPENS on recurrence (cooldown-gated), all audited.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-escalation-breach');
  const { G } = setupEnv({ config: { role: 'owner', governanceEscalationCooldownMs: 1000 } });
  let T = 1000000;
  G.AAA_RUNTIME_CLOCK = { now: () => T, nowISO: () => new Date(T).toISOString() };
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  const E = G.AAA_GOVERNANCE_ESCALATION;
  const L = G.AAA_AUDIT_LEDGER;

  const breach = (extra) => Object.assign({ kind: 'agent_accuracy', domain: 'agent', category: 'estimator', metric: 'accuracy', value: 0.4, threshold: 0.6, severity: 'high', detail: 'Accuracy below threshold.', recommendedAction: 'Retrain.' }, extra || {});

  // ---- raise --------------------------------------------------------------
  let r = await E.escalateBreach(breach());
  t.ok('breach raised', r.escalated === true && r.escalation.status === 'open');
  const id = r.escalation.id;
  t.ok('carries metric/value/threshold/detail', r.escalation.metric === 'accuracy' && r.escalation.value === 0.4 && r.escalation.threshold === 0.6 && !!r.escalation.detail);
  t.ok('raise audited with metric', (await L.chain()).some((e) => e.type === 'escalation_raised' && e.payload.metric === 'accuracy' && e.payload.recommendedAction === 'Retrain.'));

  // ---- duplicate within cooldown suppressed -------------------------------
  r = await E.escalateBreach(breach({ value: 0.38 }));
  t.ok('within cooldown → suppressed', r.escalated === false && r.suppressed === true && r.renotified === false);

  // ---- cooldown elapsed → re-notify (sets lastNotifiedAt = now) -----------
  T += 2000;
  r = await E.escalateBreach(breach({ value: 0.35 }));
  t.ok('past cooldown → renotified', r.renotified === true);
  t.ok('notifyCount incremented', r.escalation.notifyCount === 2);

  // ---- resolve (last notify is "now", so cooldown is fresh) ----------------
  await E.resolve(id, { actorId: 'owner_1' });
  t.eq('resolved status', (await E.list()).find((x) => x.id === id).status, 'resolved');

  // recurrence within cooldown of the last notify → suppressed, stays resolved
  r = await E.escalateBreach(breach());
  t.eq('resolved + within cooldown → suppressed', r.reason, 'COOLDOWN');
  t.eq('still resolved', (await E.list()).find((x) => x.id === id).status, 'resolved');

  // recurrence past cooldown → RE-OPENS (condition came back)
  T += 2000;
  r = await E.escalateBreach(breach({ value: 0.3 }));
  t.ok('resolved breach re-opens on recurrence', r.escalated === true && r.reopened === true && r.escalation.status === 'open');
  t.ok('reopen audited', (await L.chain()).some((e) => e.type === 'escalation_reopened'));

  // ---- acknowledge silences re-notification -------------------------------
  await E.acknowledge(id, { actorId: 'owner_1' });
  T += 5000;
  r = await E.escalateBreach(breach());
  t.ok('acknowledged → not renotified', r.renotified === false);

  t.ok('audit ledger verifies', (await L.verify()).ok === true);
  return t.report();
};
