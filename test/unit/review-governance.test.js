/*
 * Review engine ↔ Governance integration (no network).
 *
 * A blocked AI-drafted review request must register an overridable governance
 * case, store its id on the safety record, and remain unsent until an Admin
 * overrides AND a human explicitly sends.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('review-governance');
  const { G, cfg, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1', businessName: 'AAA Carpet' } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-engine.js');

  G.AAA_DATA.callAgent = async () => ({ ok: true, text: 'Hi Jane, thanks!' });
  G.AAA_CONTENT_SAFETY = { isReady: () => true, async checkResponse() { return { ok: true, safe: false, flagged: true, verdict: 'unsafe', categories: ['S2'], raw: { 'User Safety': 'unsafe' } }; } };

  load('js/agents/review-request-engine.js');
  const engine = G.AAA_REVIEW_REQUEST_ENGINE;
  const gov = G.AAA_GOVERNANCE;

  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane Doe', notes: 'cleaned carpets' });
  const r = await engine.requestReview('j1');

  t.eq('blocked review held', r.review.status, 'blocked');
  t.ok('governance case id stored on safety', !!r.review.safety.governanceCaseId);

  const c = await gov.getCase(r.review.safety.governanceCaseId);
  t.ok('governance case exists + open', !!c && c.status === 'open' && c.decision === 'block');
  t.eq('case links back to the review (messageContextId)', c.messageContextId, r.review.id);
  t.ok('case carries the draft for review', c.draft === r.review.message);

  // Override → unlocks but does not send; then explicit send transitions to sent.
  const ov = await gov.requestOverride(c.id, { reason: 'Reviewed; standard thank-you message, safe to send.' });
  t.ok('admin override unlocks', ov.ok === true && ov.unlocked === true);
  t.eq('still not sent after override', (await gov.getCase(c.id)).status, 'overridden');
  await gov.recordSent(c.id, { channel: 'sms' });
  t.eq('explicit send marks sent', (await gov.getCase(c.id)).status, 'sent');

  return t.report();
};
