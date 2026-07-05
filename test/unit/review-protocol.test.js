/* Review Protocol — the reviewer that can BLOCK but never GRANT.
 *
 * Guards the honest contract: verdicts are schema-locked (reject without
 * named defects is refused; approve with critical severity is refused), a
 * critical reject auto-rejects the reviewed envelope, a reviewer approval
 * NEVER approves the envelope (granting stays human), an already-approved
 * envelope is flagged — not silently unwound — and with no model configured
 * review() returns AI_NOT_CONFIGURED, never an invented verdict. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('review-protocol');
  const { G } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/agents/review-protocol.js');
  const RP = G.AAA_REVIEW_PROTOCOL, ENV = G.AAA_DECISION_ENVELOPE, LED = G.AAA_AUDIT_LEDGER;

  // ===== honest gating =====
  t.eq('without a model, review() refuses honestly', (await RP.review('artifact')).error, 'AI_NOT_CONFIGURED');
  t.eq('empty artifact refused', (await RP.review('')).error, 'NO_ARTIFACT');

  // Stub reviewer (governed seam).
  let verdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  RP.setExecutor({ name: 'stub', run: async () => ({ ok: true, output: verdict }) });

  // ===== clean approve persists =====
  const r1 = await RP.review('The quote artifact', { kind: 'quote', artifactRef: 'q1' });
  t.ok('approve verdict persists', r1.ok === true && r1.verdict.decision === 'approve' && r1.verdict.artifactRef === 'q1');
  t.ok('audit chain verifies after verdict', (await LED.verify()).ok === true);

  // ===== the rules the model cannot talk past =====
  verdict = { decision: 'reject', severity: 'critical', defects: [], confidence: 0.8 };
  const vibes = await RP.review('x');
  t.ok('reject without defects refused (no vibes-rejects)', vibes.error === 'BAD_VERDICT' && vibes.issues.some((s) => s.indexOf('at least one defect') !== -1));
  verdict = { decision: 'approve', severity: 'critical', defects: [], confidence: 0.8 };
  t.ok('approve with critical severity is a contradiction', (await RP.review('x')).issues.some((s) => s.indexOf('contradiction') !== -1));
  verdict = { decision: 'reject', severity: 'high', defects: [{ type: 'policy', description: 'bad' }], confidence: 0.8 };
  t.ok('defect without fix_instruction refused', (await RP.review('x')).issues.some((s) => s.indexOf('fix_instruction') !== -1));
  verdict = { decision: 'maybe', severity: 'none', defects: [], confidence: 2 };
  const multi = await RP.review('x');
  t.ok('bad decision + confidence both named', multi.issues.length >= 2);

  // ===== envelope enforcement: the brake works =====
  const w1 = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Same invoice flow for Germany and Texas', rationale: 'Simpler.', confidence: 88, risks: [], next_actions: [] }, impact: { amount: 900 }, country: 'DE' });
  await ENV.seal(w1.envelope);
  verdict = { decision: 'reject', severity: 'critical', defects: [{ type: 'i18n', description: 'German invoices need USt treatment; Texas sales-tax flow is not lawful in DE', evidence_ref: 'country-packs:DE', fix_instruction: 'split the flow per market using the DE country pack' }], confidence: 0.95 };
  const enforce = await RP.reviewEnvelope(w1.envelope.id);
  t.eq('critical reject auto-rejects the envelope', enforce.enforcement, 'envelope_rejected');
  t.eq('envelope is now rejected', (await ENV.get(w1.envelope.id)).approval.status, 'rejected');
  t.ok('rejection reason carries the defect', (await ENV.get(w1.envelope.id)).approval.reason.indexOf('USt') !== -1);

  // ===== asymmetry: reviewer approval never grants =====
  const w2 = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Send localized DE quote', rationale: 'Pack applied.', confidence: 85, risks: [], next_actions: ['send email to customer'] }, country: 'DE' });
  await ENV.seal(w2.envelope);
  verdict = { decision: 'approve', severity: 'none', defects: [], confidence: 0.9 };
  const ok2 = await RP.reviewEnvelope(w2.envelope.id);
  t.eq('reviewer approve does NOT approve the envelope', (await ENV.get(w2.envelope.id)).approval.status, 'awaiting_approval');
  t.ok('the asymmetry is stated in the result', String(ok2.note).indexOf('stays with the human') !== -1);

  // ===== already human-approved: flag, never silently unwind =====
  const w3 = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Standard job', rationale: 'Fine.', confidence: 90, risks: [], next_actions: [] } });
  await ENV.seal(w3.envelope);
  await ENV.approve(w3.envelope.id, { approver: 'aaron' });
  verdict = { decision: 'reject', severity: 'critical', defects: [{ type: 'factual', description: 'late finding', fix_instruction: 'revisit' }], confidence: 0.7 };
  const late = await RP.reviewEnvelope(w3.envelope.id);
  t.eq('post-approval critical reject flags loudly instead of unwinding', late.enforcement, 'flagged_post_approval');
  t.eq('human approval stands', (await ENV.get(w3.envelope.id)).approval.status, 'approved');

  // ===== a non-critical reject records but does not enforce =====
  const w4 = ENV.wrap({ agent: 'sales', decision: { recommendation: 'Minor copy tweak', rationale: 'Fine.', confidence: 75, risks: [], next_actions: [] } });
  await ENV.seal(w4.envelope);
  verdict = { decision: 'reject', severity: 'medium', defects: [{ type: 'other', description: 'tone', fix_instruction: 'soften' }], confidence: 0.6 };
  t.eq('medium reject records without enforcement', (await RP.reviewEnvelope(w4.envelope.id)).enforcement, 'none');

  // ===== reads =====
  t.eq('unknown envelope → ENVELOPE_NOT_FOUND', (await RP.reviewEnvelope('nope')).error, 'ENVELOPE_NOT_FOUND');
  const rejects = await RP.list({ decision: 'reject' });
  t.ok('list filters by decision', rejects.length === 3);
  t.ok('list filters by artifactRef', (await RP.list({ artifactRef: w1.envelope.id })).length === 1);
  const thrower = await (async () => { RP.setExecutor({ name: 'boom', run: async () => { throw new Error('kaput'); } }); return RP.review('x'); })();
  t.ok('throwing executor caught honestly', thrower.ok === false && String(thrower.error).indexOf('EXECUTOR_THREW') === 0);
  RP.setExecutor(null);

  return t.report();
};
