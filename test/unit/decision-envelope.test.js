/* Decision Envelope — the one contract every agent decision ships in.
 *
 * Guards the honest contract: destructive next_actions force approval, a
 * gate-DENIED envelope can never be human-approved, low confidence forces
 * approval, impact is localized through country packs (€ in Berlin), sealing
 * chains into the audit ledger (and the chain still verifies), invalid
 * envelopes are refused, and a missing safety gate degrades CONSERVATIVELY
 * (actions require approval) rather than permissively. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('decision-envelope');
  const { G } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  const ENV = G.AAA_DECISION_ENVELOPE, LED = G.AAA_AUDIT_LEDGER;

  const baseDecision = {
    recommendation: 'Send the follow-up quote at the standard rate',
    rationale: 'Customer asked for it and margins clear the floor.',
    confidence: 82, risks: [], next_actions: ['draft the quote locally']
  };

  // ===== a clean, low-risk decision auto-approves =====
  const w1 = ENV.wrap({ agent: 'sales', decision: baseDecision, impact: { amount: 450, description: 'quote value' }, rollback: { plan: 'delete the draft', reversible: true } });
  t.ok('wrap returns an envelope', w1.ok === true && !!w1.envelope.id);
  t.eq('low-risk decision auto-approves', w1.envelope.approval.status, 'auto_approved');
  t.eq('gate ran and allowed', w1.envelope.gate.decision, 'allow');
  t.eq('impact localized to active market (USD)', w1.envelope.impact.currency, 'USD');
  t.ok('impact has human formatting', /450/.test(w1.envelope.impact.formatted));
  t.ok('validate passes', ENV.validate(w1.envelope).ok === true);

  // ===== destructive action → approval required =====
  const w2 = ENV.wrap({ agent: 'operations', decision: Object.assign({}, baseDecision, { next_actions: ['send email to the customer with the invoice'] }), rollback: { plan: 'none', reversible: false } });
  t.eq('external/destructive action needs approval', w2.envelope.approval.status, 'awaiting_approval');
  t.ok('reason names the gate', w2.envelope.approval.reasons.some((r) => r.indexOf('safety gate') !== -1));

  // ===== catastrophic action → blocked, and approve() refuses =====
  const w3 = ENV.wrap({ agent: 'ops', decision: Object.assign({}, baseDecision, { next_actions: ['rm -rf / on the server'] }) });
  t.eq('catastrophic action is blocked', w3.envelope.approval.status, 'blocked');
  await ENV.seal(w3.envelope);
  const denyApprove = await ENV.approve(w3.envelope.id, { approver: 'owner' });
  t.eq('a gate-DENIED envelope can NEVER be approved', denyApprove.error, 'GATE_DENIED');

  // ===== low confidence → approval =====
  const w4 = ENV.wrap({ agent: 'pricing', decision: Object.assign({}, baseDecision, { confidence: 30 }) });
  t.eq('confidence below floor needs approval', w4.envelope.approval.status, 'awaiting_approval');
  t.ok('reason names the confidence floor', w4.envelope.approval.reasons.some((r) => r.indexOf('below floor') !== -1));

  // ===== high-stakes money → escalation forces approval =====
  const w5 = ENV.wrap({ agent: 'sales', decision: baseDecision, impact: { amount: 5000 }, context: { quote: '$5000' } });
  t.eq('high-stakes value routes to approval', w5.envelope.approval.status, 'awaiting_approval');
  t.ok('escalation available and fired', w5.envelope.escalation.available === true && w5.envelope.escalation.highStakes === true);

  // ===== localization: a Berlin decision carries EUR =====
  const w6 = ENV.wrap({ agent: 'sales', decision: baseDecision, impact: { amount: 1200 }, country: 'DE' });
  t.eq('DE envelope impact is EUR', w6.envelope.impact.currency, 'EUR');
  t.eq('country recorded on the envelope', w6.envelope.country, 'DE');

  // ===== seal: audit-chained persistence =====
  const s1 = await ENV.seal(w1.envelope);
  t.ok('seal persists with an audit ref', s1.ok === true && !!s1.envelope.audit && !!s1.envelope.audit.id);
  const chain = await LED.verify();
  t.ok('audit chain still verifies after sealing', chain.ok === true);
  t.ok('sealed envelope is readable', (await ENV.get(w1.envelope.id)).id === w1.envelope.id);

  // ===== invalid envelopes are refused =====
  const badSeal = await ENV.seal({ id: 'x', schemaVersion: '1.0' });
  t.ok('invalid envelope refused with named gaps', badSeal.error === 'INVALID_ENVELOPE' && badSeal.issues.length >= 4);
  const badWrap = ENV.wrap({ agent: 'sales', decision: { recommendation: 'do it' } });
  t.ok('wrap refuses incomplete decisions', badWrap.ok === false && badWrap.issues.length >= 2);

  // ===== approve / reject transitions =====
  await ENV.seal(w2.envelope);
  const ap = await ENV.approve(w2.envelope.id, { approver: 'aaron' });
  t.ok('approval transitions with approver + timestamp', ap.ok === true && ap.envelope.approval.status === 'approved' && ap.envelope.approval.approver === 'aaron' && !!ap.envelope.approval.decidedAt);
  t.eq('double-approve refused', (await ENV.approve(w2.envelope.id)).error, 'ALREADY_APPROVED');
  await ENV.seal(w4.envelope);
  const rj = await ENV.reject(w4.envelope.id, { approver: 'aaron', reason: 'price too low' });
  t.ok('reject records the reason', rj.ok === true && rj.envelope.approval.status === 'rejected' && rj.envelope.approval.reason === 'price too low');
  t.eq('approve of unknown id → NOT_FOUND', (await ENV.approve('nope')).error, 'NOT_FOUND');

  // ===== list: workspace-scoped, filterable =====
  const awaiting = await ENV.list({ status: 'approved' });
  t.ok('list filters by status', awaiting.length === 1 && awaiting[0].id === w2.envelope.id);
  const byCountry = ENV.wrap({ agent: 'sales', decision: baseDecision, country: 'GB' });
  await ENV.seal(byCountry.envelope);
  t.ok('list filters by country', (await ENV.list({ country: 'GB' })).length === 1);

  // ===== conservative degradation: no gate → actions need a human =====
  const savedGate = G.AAA_ACTION_GATE; delete G.AAA_ACTION_GATE;
  const w7 = ENV.wrap({ agent: 'sales', decision: baseDecision });
  t.ok('missing gate is recorded honestly', w7.envelope.gate.available === false);
  t.eq('missing gate + actions → approval required (conservative)', w7.envelope.approval.status, 'awaiting_approval');
  const w8 = ENV.wrap({ agent: 'sales', decision: Object.assign({}, baseDecision, { next_actions: [] }) });
  t.eq('missing gate + NO actions → still auto-approvable', w8.envelope.approval.status, 'auto_approved');
  G.AAA_ACTION_GATE = savedGate;

  // ===== events published on the typed bus =====
  const sealedEvents = (await G.AAA_EVENT_BUS.log()).filter((e) => e.type === 'envelope.sealed');
  t.ok('envelope.sealed events landed on the typed bus', sealedEvents.length >= 2);

  return t.report();
};
