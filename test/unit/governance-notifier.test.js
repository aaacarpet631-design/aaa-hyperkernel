/*
 * Governance Notifier — event→channel delivery (no network).
 *
 * Verifies: subscription to 'governance.escalation', priority gating, cooldown
 * respect (suppressed escalations emit no event → no email), audit logging of
 * attempt/success/failure with provider response + timestamp, no-PII payloads,
 * and that a channel failure never throws into the app.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function bus() {
  const h = {};
  return {
    onCalls: [],
    on(type, fn) { (h[type] = h[type] || []).push(fn); this.onCalls.push(type); },
    emit(type, p) { (h[type] || []).forEach((fn) => fn(p, type)); }
  };
}

module.exports = async function run() {
  const t = makeRunner('gov-notifier');
  const { G } = setupEnv({ config: { role: 'owner', governanceAlertMinPriority: 'high', governanceEscalationCooldownMs: 1000 } });
  let T = 1000000;
  G.AAA_RUNTIME_CLOCK = { now: () => T, nowISO: () => new Date(T).toISOString() };
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');

  // Notifier subscribes to whatever bus is global at load — use a spy bus.
  const spy = bus();
  G.AAA_EVENTS = spy;
  load('js/governance/governance-notifier.js');
  const N = G.AAA_GOVERNANCE_NOTIFIER;
  const E = G.AAA_GOVERNANCE_ESCALATION;
  const L = G.AAA_AUDIT_LEDGER;

  // #1 subscription
  t.ok('subscribed to governance.escalation', spy.onCalls.indexOf('governance.escalation') !== -1 && N._wired === true);

  // Stub email channel we fully control (no network).
  let sends = []; let mode = 'ok';
  N.registerChannel('email', { send: async (p) => {
    sends.push(p);
    if (mode === 'throw') throw new Error('SMTP down');
    if (mode === 'reject') return { ok: false, status: 502, response: { message: 'rejected' } };
    return { ok: true, status: 200, response: { id: 'em_1' } };
  } });

  // ---- priority gating ----------------------------------------------------
  let r = await N.handle({ priority: 'low', escalationId: 'x' });
  t.ok('low priority not delivered', r.delivered === false && r.reason === 'BELOW_PRIORITY');
  t.ok('no send for low priority', sends.length === 0);

  // ---- cooldown respect: drive real escalation onto an ISOLATED bus -------
  // (notifier is subscribed to `spy`, not this collector, so we count purely
  // what the escalation engine emits — proving cooldown gates delivery.)
  const collector = bus(); const emitted = [];
  G.AAA_EVENTS = collector;
  collector.on('governance.escalation', (e) => emitted.push(e));
  const args = (count) => ({ kind: 'drift_override', domain: 'content_safety', category: 'S2', count, threshold: 3, affectedCaseIds: ['gov_1', 'gov_2'] });

  await E.escalate(args(3));            // crossing → emits
  await E.escalate(args(4));            // same window, within cooldown → suppressed (no emit)
  t.eq('cooldown suppresses the 2nd (no new event)', emitted.length, 1);
  T += 2000;                           // past cooldown
  await E.escalate(args(5));            // open window, cooldown elapsed → re-notify emits
  t.eq('re-notify emits after cooldown', emitted.length, 2);

  // Feed the (cooldown-gated) events through the notifier → deliveries track events.
  for (const e of emitted) await N.handle(e);
  t.eq('one email per emitted high event (cooldown respected)', sends.length, 2);
  t.ok('payload carries governance metadata', sends[0].domain === 'content_safety' && sends[0].category === 'S2' && sends[0].affectedCaseIds.length === 2);
  t.ok('payload has recommended action + threshold + count', !!sends[0].recommendedAction && sends[0].threshold === 3 && typeof sends[0].count === 'number');

  // ---- no PII in payload (allowlist) --------------------------------------
  const keys = Object.keys(sends[0]);
  const allowed = ['escalationId', 'kind', 'domain', 'category', 'count', 'threshold', 'affectedCaseIds', 'recommendedAction', 'dashboardUrl', 'priority'];
  t.ok('payload keys are allowlisted only', keys.every((k) => allowed.indexOf(k) !== -1));
  t.ok('no customer fields present', keys.indexOf('message') === -1 && keys.indexOf('customerName') === -1 && keys.indexOf('draft') === -1);

  // ---- audit logging: attempt + delivered --------------------------------
  let chain = await L.chain();
  const attempt = chain.find((x) => x.type === 'alert_attempt');
  const delivered = chain.find((x) => x.type === 'alert_delivered');
  t.ok('attempt audited with channel + escalation + timestamp', !!attempt && attempt.payload.channel === 'email' && !!attempt.payload.at);
  t.ok('delivery audited with provider response', !!delivered && delivered.payload.providerResponse && delivered.payload.providerResponse.id === 'em_1');

  // ---- provider failure: audited, returns gracefully ----------------------
  mode = 'reject'; sends = [];
  r = await N.handle(emitted[0]);
  t.ok('provider rejection → not delivered, no throw', r.ok === true && r.delivered === false);
  t.ok('failure audited', (await L.chain()).some((x) => x.type === 'alert_failed' && x.payload.channel === 'email'));

  // ---- channel throws: caught, app does not crash -------------------------
  mode = 'throw';
  r = await N.handle(emitted[0]);
  t.ok('thrown channel error is caught', r.ok === true && r.delivered === false);
  t.ok('thrown failure audited with error', (await L.chain()).some((x) => x.type === 'alert_failed' && x.payload.error && /SMTP down/.test(x.payload.error)));

  // audit chain remains intact through all of it
  t.ok('audit ledger verifies', (await L.verify()).ok === true);

  return t.report();
};
