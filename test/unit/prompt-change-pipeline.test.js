/*
 * Phase 4B — human-approved prompt change pipeline (no network).
 * Verifies: proposal from accepted task, non-admin cannot approve, approval
 * requires note/checklist/rollback, rejected can't be implemented, patch-only
 * without a safe registry, guarded apply WITH a registry, rollback audited, and
 * PII-stripped evidence export. No autonomy.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('prompt-pipeline');
  const { G, cfg, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1' } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-learning.js');
  load('js/governance/prompt-change-pipeline.js');
  const P = G.AAA_PROMPT_PIPELINE, L = G.AAA_AUDIT_LEDGER;

  // ---- pure: approval validation -----------------------------------------
  t.eq('approve forbidden when not admin', P.validateApproval(false, { note: 'x'.repeat(10), checklistConfirmed: true, rollbackNote: 'rb' }).error, 'FORBIDDEN');
  t.eq('approve needs note', P.validateApproval(true, { checklistConfirmed: true, rollbackNote: 'rb ok' }).error, 'APPROVAL_NOTE_REQUIRED');
  t.eq('approve needs checklist', P.validateApproval(true, { note: 'a sufficiently long note', rollbackNote: 'rb ok' }).error, 'CHECKLIST_REQUIRED');
  t.eq('approve needs rollback', P.validateApproval(true, { note: 'a sufficiently long note', checklistConfirmed: true }).error, 'ROLLBACK_NOTE_REQUIRED');
  t.ok('valid approval ok', P.validateApproval(true, { note: 'a sufficiently long note', checklistConfirmed: true, rollbackNote: 'revert prompt' }).ok === true);

  // seed an accepted improvement task + an evidence training case (with PII)
  await data.put('gov_improvement_tasks', 'task1', { taskId: 'task1', agentId: 'estimator', issue: 'low accuracy on stairs', recommendedChange: 'Add a stair sqft sanity check', sourceTrainingCases: ['tc1'] });
  await data.put('gov_training_queue', 'tc1', { id: 'tc1', decisionId: 'd1', agentType: 'estimator', decision: { recommendation: 'call 555-111-2222 or jane@x.com', confidence: 0.6 }, outcome: { result: 'lost_job' }, finalResult: 'unsuccessful', createdAt: 1 });

  // ---- proposal created from accepted task -------------------------------
  const cp = await P.createProposal({ taskId: 'task1', proposedChange: 'Add: verify stair count × 18in tread before quoting.' });
  t.ok('proposal created (draft)', cp.ok === true && cp.proposal.status === 'draft' && cp.proposal.agentId === 'estimator');
  t.ok('proposal seeded from task (evidence + reason)', cp.proposal.evidenceCases[0] === 'tc1' && /stairs/.test(cp.proposal.reason));
  t.ok('no registry → current version unknown', cp.proposal.currentPrompt === null);
  t.ok('creation audited', (await L.chain()).some((e) => e.type === 'prompt_proposal_created' && e.payload.proposalId === cp.proposal.proposalId));
  const pid = cp.proposal.proposalId;

  await P.submit(pid, {});
  t.eq('submitted', (await P.get(pid)).status, 'submitted');

  // ---- non-admin cannot approve ------------------------------------------
  cfg.set({ role: 'crew' });
  t.eq('crew cannot approve', (await P.approve(pid, { note: 'looks good to me overall', checklistConfirmed: true, rollbackNote: 'revert' })).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  // ---- approval requires note/checklist/rollback -------------------------
  t.eq('missing note rejected', (await P.approve(pid, { checklistConfirmed: true, rollbackNote: 'revert' })).error, 'APPROVAL_NOTE_REQUIRED');
  t.eq('missing checklist rejected', (await P.approve(pid, { note: 'reviewed, safe to apply', rollbackNote: 'revert' })).error, 'CHECKLIST_REQUIRED');
  t.eq('missing rollback rejected', (await P.approve(pid, { note: 'reviewed, safe to apply', checklistConfirmed: true })).error, 'ROLLBACK_NOTE_REQUIRED');
  const appr = await P.approve(pid, { note: 'Reviewed against the 5 failed stair quotes; safe.', checklistConfirmed: true, rollbackNote: 'Restore prior estimator prompt.' });
  t.ok('approved with full gate', appr.ok === true && appr.proposal.status === 'approved');
  t.ok('approval audited', (await L.chain()).some((e) => e.type === 'prompt_proposal_approved' && e.payload.proposalId === pid));

  // ---- implementation is patch-only without a safe registry --------------
  const impl = await P.implement(pid, {});
  t.ok('implemented as manual patch (not applied)', impl.ok === true && impl.applied === false && !!impl.patch);
  t.ok('patch describes manual application', /no safe prompt registry/i.test(impl.patch.instructions));
  t.ok('implementation audited applied:false', (await L.chain()).some((e) => e.type === 'prompt_proposal_implemented' && e.payload.applied === false));

  // ---- rejected proposals cannot be implemented --------------------------
  const cp2 = await P.createProposal({ taskId: 'task1', proposedChange: 'Different change' });
  await P.submit(cp2.proposal.proposalId, {});
  await P.reject(cp2.proposal.proposalId, { reason: 'not now' });
  t.eq('rejected cannot be implemented', (await P.implement(cp2.proposal.proposalId, {})).error, 'NOT_APPROVED');
  t.ok('rejection audited', (await L.chain()).some((e) => e.type === 'prompt_proposal_rejected'));

  // ---- guarded apply WHEN a safe registry is registered ------------------
  let applied = null, rolledBack = null;
  P.registerRegistry({ getPrompt: function () { return 'CURRENT PROMPT v1'; }, apply: function (a, c) { applied = { a: a, c: c }; return { ok: true, version: 'v2' }; }, rollback: function (a, v) { rolledBack = { a: a, v: v }; return { ok: true }; } });
  const cp3 = await P.createProposal({ taskId: 'task1', proposedChange: 'Registry-applied change' });
  t.ok('registry supplies current version', cp3.proposal.currentPrompt === 'CURRENT PROMPT v1');
  await P.submit(cp3.proposal.proposalId, {});
  await P.approve(cp3.proposal.proposalId, { note: 'Verified in staging thoroughly.', checklistConfirmed: true, rollbackNote: 'Revert to v1.' });
  const impl3 = await P.implement(cp3.proposal.proposalId, {});
  t.ok('registry apply path used', impl3.applied === true && impl3.proposal.appliedVersion === 'v2' && applied && applied.c === 'Registry-applied change');

  // ---- rollback tracked + audited ----------------------------------------
  const rb = await P.rollback(cp3.proposal.proposalId, { reason: 'regression found' });
  t.ok('rolled back via registry', rb.ok === true && rb.proposal.status === 'rolled_back' && rolledBack);
  t.ok('rollback links proposal + task + audited', (await L.chain()).some((e) => e.type === 'prompt_proposal_rolled_back' && e.payload.proposalId === cp3.proposal.proposalId && e.payload.taskId === 'task1'));
  // a non-implemented (rejected) proposal cannot be rolled back
  t.eq('cannot rollback a non-implemented proposal', (await P.rollback(cp2.proposal.proposalId, {})).error, 'BAD_TRANSITION');

  // ---- PII stripped from evidence export ---------------------------------
  const ev = await P.exportEvidence(pid, {});
  t.ok('evidence export returns jsonl', ev.ok === true && ev.count === 1);
  t.ok('evidence strips phone + email', ev.jsonl.indexOf('555-111-2222') === -1 && ev.jsonl.indexOf('jane@x.com') === -1 && ev.jsonl.indexOf('[phone]') !== -1 && ev.jsonl.indexOf('[email]') !== -1);
  t.ok('evidence export audited', (await L.chain()).some((e) => e.type === 'prompt_evidence_exported' && e.payload.proposalId === pid));

  t.ok('audit ledger verifies', (await L.verify()).ok === true);
  return t.report();
};
