/*
 * Governance Escalation — generic owner/admin alerting for governance risks
 * (no network). Verifies threshold crossing, cooldown rate-limiting, duplicate
 * suppression, audit logging of every transition, and that a resolved window
 * does not re-open unless a NEW threshold window is hit.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-escalation');
  const { G, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1', governanceEscalationCooldownMs: 1000 } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  const E = G.AAA_GOVERNANCE_ESCALATION;
  const L = G.AAA_AUDIT_LEDGER;

  // Controllable clock so cooldown is deterministic.
  let T = 1000000;
  G.AAA_RUNTIME_CLOCK = { now: () => T, nowISO: () => new Date(T).toISOString() };

  // ---- pure helpers -------------------------------------------------------
  t.ok('windowIndexFor below threshold = 0', E.windowIndexFor(2, 3) === 0);
  t.ok('windowIndexFor at threshold = 1', E.windowIndexFor(3, 3) === 1);
  t.ok('windowIndexFor within window stays 1', E.windowIndexFor(5, 3) === 1);
  t.ok('windowIndexFor next window = 2', E.windowIndexFor(6, 3) === 2);
  t.ok('cooldown elapsed when past', E.cooldownElapsed(0, 1000, 1000) === true);
  t.ok('cooldown not elapsed when recent', E.cooldownElapsed(950, 1000, 1000) === false);
  t.ok('null lastAt → elapsed', E.cooldownElapsed(null, 0, 1000) === true);

  const args = (count, ids) => ({ kind: 'drift_override', domain: 'content_safety', category: 'S2', count: count, threshold: 3, affectedCaseIds: ids || [], guardrail: 'nvidia/nemotron-3-content-safety' });

  // ---- below threshold → no escalation, no alert --------------------------
  let r = await E.escalate(args(2));
  t.eq('below threshold → not escalated', r.escalated, false);
  t.eq('below threshold reason', r.reason, 'BELOW_THRESHOLD');

  // ---- threshold crossing → raise + notify --------------------------------
  r = await E.escalate(args(3, ['c1', 'c2', 'c3']));
  t.ok('threshold crossing → escalated', r.escalated === true);
  const esc = r.escalation;
  t.eq('status open', esc.status, 'open');
  t.eq('overrideCount captured', esc.overrideCount, 3);
  t.eq('threshold captured', esc.threshold, 3);
  t.ok('affected case ids included', esc.affectedCaseIds.length === 3);
  t.ok('recommended action present', typeof esc.recommendedAction === 'string' && esc.recommendedAction.length > 0);
  t.eq('notifyCount 1', esc.notifyCount, 1);

  // ---- duplicate suppression (same window, no cooldown elapsed) -----------
  r = await E.escalate(args(4, ['c1', 'c2', 'c3', 'c4']));
  t.ok('same window, within cooldown → suppressed', r.escalated === false && r.suppressed === true && r.renotified === false);
  t.eq('still notifyCount 1 (no spam)', (await E.list()).find((x) => x.id === esc.id).notifyCount, 1);

  // ---- cooldown elapsed → re-notify (still same window) -------------------
  T += 2000; // past the 1000ms cooldown
  r = await E.escalate(args(5, ['c1', 'c2', 'c3', 'c4', 'c5']));
  t.ok('past cooldown → re-notified', r.renotified === true);
  t.eq('notifyCount incremented', r.escalation.notifyCount, 2);
  t.ok('still same window (w1)', r.escalation.windowIndex === 1);

  // ---- audit logging of raise + notify ------------------------------------
  let chain = await L.chain();
  const raised = chain.find((e) => e.type === 'escalation_raised');
  t.ok('escalation_raised on ledger', !!raised && raised.payload.category === 'S2' && raised.payload.threshold === 3);
  t.ok('raised carries affected ids + recommendation', raised.payload.affectedCaseIds.length === 3 && !!raised.payload.recommendedAction);
  t.ok('escalation_notified on ledger', chain.some((e) => e.type === 'escalation_notified'));

  // ---- acknowledge silences re-notification -------------------------------
  await E.acknowledge(esc.id, { actorId: 'owner_1' });
  t.eq('acknowledged status', (await E.list()).find((x) => x.id === esc.id).status, 'acknowledged');
  t.ok('acknowledge audited', (await L.chain()).some((e) => e.type === 'escalation_acknowledged'));
  T += 5000;
  r = await E.escalate(args(5, ['c1', 'c2', 'c3', 'c4', 'c5']));
  t.ok('acknowledged → not re-notified even past cooldown', r.renotified === false);

  // ---- resolve, then resolved window does NOT re-open ---------------------
  await E.resolve(esc.id, { actorId: 'owner_1' });
  t.eq('resolved status', (await E.list()).find((x) => x.id === esc.id).status, 'resolved');
  t.ok('resolve audited', (await L.chain()).some((e) => e.type === 'escalation_resolved'));
  T += 100000;
  r = await E.escalate(args(5, ['c1', 'c2', 'c3', 'c4', 'c5']));
  t.eq('resolved window not re-opened', r.reason, 'RESOLVED_WINDOW');
  t.ok('resolved window stays resolved', r.escalated === false);

  // ---- a NEW threshold window DOES raise a fresh escalation ---------------
  r = await E.escalate(args(6, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']));
  t.ok('new window (w2) raises fresh escalation', r.escalated === true && r.escalation.windowIndex === 2);
  t.ok('fresh escalation is a distinct record', r.escalation.id !== esc.id);

  // ---- audit chain integrity throughout -----------------------------------
  t.ok('audit ledger still verifies', (await L.verify()).ok === true);

  // ---- evaluateDrift integration via the review queue ---------------------
  for (let i = 0; i < 3; i++) await data.put('governance_review_queue', 'q' + i, { caseId: 'gc' + i, domain: 'legal', categories: ['DISCLAIMER'], guardrail: 'legal-guard' });
  const d = await E.evaluateDrift({ domain: 'legal', category: 'DISCLAIMER', threshold: 3 });
  t.ok('evaluateDrift raises for a different domain', d.escalated === true && d.escalation.domain === 'legal');
  t.ok('evaluateDrift pulled affected case ids from queue', d.escalation.affectedCaseIds.length === 3);

  return t.report();
};
