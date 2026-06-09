/*
 * Governance Engine — enterprise AI-decision review/override (no network).
 *
 * Verifies: case recording (allow/block/queue), the RBAC override gate (owner
 * vs non-owner), mandatory justification, the immutable audit trail with all
 * required fields, the supervisor review queue copy, drift pattern alerts,
 * never-auto-send (override only unlocks; recordSent is separate), and the
 * dashboard metrics (override rate, false-positive candidates).
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance');
  const { G, cfg } = setupEnv({ config: { role: 'owner', firebaseUid: 'user_admin_1' } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-engine.js');
  const gov = G.AAA_GOVERNANCE_ENGINE;
  const L = G.AAA_AUDIT_LEDGER;

  // ---- pure helpers -------------------------------------------------------
  t.eq('validateOverride: forbidden', gov.validateOverride(false, 'a'.repeat(50)).error, 'FORBIDDEN');
  t.eq('validateOverride: short reason', gov.validateOverride(true, 'too short').error, 'JUSTIFICATION_REQUIRED');
  t.ok('validateOverride: ok', gov.validateOverride(true, 'a'.repeat(gov.MIN_REASON)).ok === true);

  const m0 = gov.computeMetrics([
    { decision: 'allow', status: 'allowed' },
    { decision: 'block', status: 'open' },
    { decision: 'block', status: 'overridden' },
    { decision: 'queue', status: 'overridden' }
  ]);
  t.ok('metrics counts', m0.safetyChecks === 4 && m0.blocked === 2 && m0.queued === 1 && m0.overrides === 2);
  t.ok('override rate = overrides / held', Math.abs(m0.overrideRate - (2 / 3)) < 1e-9);
  t.eq('false-positive candidates = overridden blocks', m0.falsePositiveCandidates, 1);

  // ---- record cases -------------------------------------------------------
  const safeCase = (await gov.record({ domain: 'content_safety', subjectId: 's_allow', decision: 'allow', verdict: 'safe' })).case;
  t.eq('allow → status allowed', safeCase.status, 'allowed');
  const blockRes = await gov.record({ domain: 'content_safety', guardrail: 'nvidia/nemotron-3-content-safety', model: 'nvidia/nemotron-3-content-safety', subjectType: 'review_request', subjectId: 's_block', messageContextId: 's_block', decision: 'block', verdict: 'unsafe', categories: ['S2'], raw: { 'User Safety': 'unsafe' }, draft: 'risky text' });
  const blockCase = blockRes.case;
  t.eq('block → status open', blockCase.status, 'open');
  t.ok('record is idempotent per subject', (await gov.record({ domain: 'content_safety', subjectId: 's_block', decision: 'block', categories: ['S2'] })).case.id === blockCase.id);

  // 'flagged' was written to the immutable ledger for the held case
  let chain = await L.chain();
  t.ok('flagged event on ledger', chain.some((e) => e.type === 'flagged' && e.payload.caseId === blockCase.id));

  // ---- override gate: non-admin denied ------------------------------------
  cfg.set({ role: 'crew' });
  t.ok('crew cannot override', gov.canOverride() === false);
  let res = await gov.requestOverride(blockCase.id, { reason: 'a'.repeat(40) });
  t.eq('crew override → FORBIDDEN', res.error, 'FORBIDDEN');
  t.ok('forbidden attempt audited', (await L.chain()).some((e) => e.type === 'override_forbidden'));

  // ---- override gate: admin, but justification required -------------------
  cfg.set({ role: 'owner' });
  t.ok('owner can override', gov.canOverride() === true);
  res = await gov.requestOverride(blockCase.id, { reason: 'short' });
  t.eq('blank/short reason rejected', res.error, 'JUSTIFICATION_REQUIRED');

  // case is still held — not overridden, NOT sent
  let cur = await gov.getCase(blockCase.id);
  t.eq('still open after failed override', cur.status, 'open');

  // ---- valid admin override ----------------------------------------------
  res = await gov.requestOverride(blockCase.id, { reason: 'Reviewed manually; phrasing is a standard thank-you, classifier over-flagged it.' });
  t.ok('override ok + unlocked', res.ok === true && res.unlocked === true);
  cur = await gov.getCase(blockCase.id);
  t.eq('case marked overridden', cur.status, 'overridden');
  t.ok('override NEVER auto-sends', cur.status !== 'sent' && !cur.sentAt);
  t.ok('override stores actor + reason', cur.override.actorId === 'user_admin_1' && cur.override.actorRole === 'owner' && cur.override.reason.length >= gov.MIN_REASON);

  // immutable audit trail carries every required field
  chain = await L.chain();
  const appr = chain.find((e) => e.type === 'override_approved' && e.payload.caseId === blockCase.id);
  t.ok('audit has user id + role', appr && appr.payload.actorId === 'user_admin_1' && appr.payload.actorRole === 'owner');
  t.ok('audit has original verdict + categories', appr && appr.payload.originalVerdict === 'unsafe' && appr.payload.categories[0] === 'S2');
  t.ok('audit has messageContextId + reason + finalAction', appr && appr.payload.messageContextId === 's_block' && appr.payload.reason.length >= gov.MIN_REASON && appr.payload.finalAction === 'override_unlock_send');
  t.ok('audit chain still verifies', (await L.verify()).ok === true);

  // supervisor review queue (training data) received the override
  const queue = await gov.reviewQueue();
  const q = queue.find((x) => x.caseId === blockCase.id);
  t.ok('override copied to review queue', !!q && q.status === 'pending_review' && q.overrideReason.length >= gov.MIN_REASON);
  t.ok('queue entry carries draft + decision for training', q.draft === 'risky text' && q.decision === 'block');

  // ---- explicit, audited send (separate from override) --------------------
  const sent = await gov.recordSent(blockCase.id, { channel: 'sms' });
  t.eq('recordSent → status sent', sent.case.status, 'sent');
  t.ok('sent event on ledger', (await L.chain()).some((e) => e.type === 'sent' && e.payload.caseId === blockCase.id && e.payload.viaOverride === true));

  // ---- drift pattern detection -------------------------------------------
  // Override the same category enough times to cross the threshold → alert.
  for (let i = 0; i < gov.PATTERN_THRESHOLD; i++) {
    const r = await gov.record({ domain: 'content_safety', subjectId: 'drift_' + i, decision: 'block', categories: ['S9'] });
    await gov.requestOverride(r.case.id, { reason: 'False positive on category S9, message ' + i + ' is clearly fine.' });
  }
  const alerts = await gov.alerts();
  const driftAlert = alerts.find((a) => a.category === 'S9');
  t.ok('repeated category override raises a drift alert', !!driftAlert && driftAlert.count >= gov.PATTERN_THRESHOLD);

  // ---- metrics across all cases ------------------------------------------
  const m = await gov.metrics();
  t.ok('metrics expose all counters', typeof m.safetyChecks === 'number' && typeof m.overrideRate === 'number');
  t.ok('overrides counted', m.overrides >= 1 + gov.PATTERN_THRESHOLD);
  t.ok('false-positive candidates >= 1', m.falsePositiveCandidates >= 1);
  t.ok('drift alert surfaces in metrics', m.alerts >= 1);

  return t.report();
};
