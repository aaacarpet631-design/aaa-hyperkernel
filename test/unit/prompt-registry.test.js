/*
 * Phase 5 — governed versioned prompt registry (no network).
 * Covers: create entry, runtime fallback, approved→apply, unapproved cannot
 * apply, non-admin cannot approve/apply/rollback, rollback creates a new record
 * (history never deleted), checksum/ledger tamper detection, audit, PII-stripped
 * export, and the Phase-4 adapter end-to-end.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('prompt-registry');
  const { G, cfg, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1' } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-learning.js');
  load('js/governance/prompt-change-pipeline.js');
  load('js/governance/prompt-registry.js');
  const R = G.AAA_PROMPT_REGISTRY, L = G.AAA_AUDIT_LEDGER, P = G.AAA_PROMPT_PIPELINE;

  // ---- runtime fallback when no entry exists -----------------------------
  t.eq('resolve falls back to hardcoded prompt', await R.resolve('estimator', 'FALLBACK PROMPT'), 'FALLBACK PROMPT');
  t.eq('getCurrent null when no entry', await R.getCurrent('estimator'), null);

  // ---- propose → (unapproved cannot apply) → approve → apply --------------
  const prop = await R.proposeVersion('estimator', 'V1 estimator prompt', { agentType: 'estimator', reason: 'baseline', evidenceCases: [] });
  t.ok('proposed', prop.ok === true && prop.proposal.status === 'proposed');
  t.ok('propose audited', (await L.chain()).some((e) => e.type === 'prompt_version_proposed'));
  t.eq('cannot apply an unapproved version', (await R.applyVersion(prop.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'revert' })).error, 'NOT_APPROVED');

  // non-admin cannot approve
  cfg.set({ role: 'crew' });
  t.eq('crew cannot approve', (await R.approveVersion(prop.proposal.proposalId, {})).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });
  await R.approveVersion(prop.proposal.proposalId, {});

  // apply requires checklist + rollback note
  t.eq('apply needs checklist', (await R.applyVersion(prop.proposal.proposalId, { rollbackNote: 'revert' })).error, 'CHECKLIST_REQUIRED');
  t.eq('apply needs rollback note', (await R.applyVersion(prop.proposal.proposalId, { checklistConfirmed: true })).error, 'ROLLBACK_NOTE_REQUIRED');
  // non-admin cannot apply
  cfg.set({ role: 'manager' });
  t.eq('manager cannot apply', (await R.applyVersion(prop.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'revert' })).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });
  const ap = await R.applyVersion(prop.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'restore prior' });
  t.ok('applied → v1 active', ap.ok === true && ap.version === 1);
  t.eq('runtime now resolves to registry version', await R.getCurrent('estimator'), 'V1 estimator prompt');
  t.ok('apply audited + version carries audit ref', !!ap.auditRef && (await L.chain()).some((e) => e.type === 'prompt_version_applied' && e.payload.version === 1));

  // ---- second version → history grows, prior archived --------------------
  const p2 = await R.proposeVersion('estimator', 'V2 estimator prompt', { agentType: 'estimator' });
  await R.approveVersion(p2.proposal.proposalId, {});
  const ap2 = await R.applyVersion(p2.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'restore v1' });
  t.eq('current is v2', ap2.version, 2);
  const hist2 = await R.history('estimator');
  t.ok('history retains both versions', hist2.length === 2 && hist2[0].status === 'archived' && hist2[1].status === 'active');

  // ---- rollback creates a NEW record, never deletes ----------------------
  cfg.set({ role: 'crew' });
  t.eq('crew cannot rollback', (await R.rollback('estimator', 1, {})).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });
  const rb = await R.rollback('estimator', 1, { reason: 'v2 regressed' });
  t.eq('rollback adds v3', rb.version, 3);
  const hist3 = await R.history('estimator');
  t.ok('history never deleted (3 records)', hist3.length === 3);
  t.ok('rollback v3 carries v1 text + rollbackOf', hist3[2].text === 'V1 estimator prompt' && hist3[2].rollbackOf === 1);
  t.eq('current resolves to rolled-back text', await R.getCurrent('estimator'), 'V1 estimator prompt');
  t.ok('rollback audited', (await L.chain()).some((e) => e.type === 'prompt_version_rolled_back' && e.payload.toVersion === 1));

  // ---- tamper detection ---------------------------------------------------
  t.ok('clean history verifies', (await R.verify('estimator')).ok === true);
  t.ok('ledger cross-check verifies', (await R.verifyAgainstLedger('estimator')).ok === true);
  const e = await data.get('gov_prompt_registry', 'estimator');
  const tampered = Object.assign({}, e, { versions: e.versions.map((v) => v.version === 2 ? Object.assign({}, v, { text: 'HACKED PROMPT' }) : v) });
  await data.put('gov_prompt_registry', 'estimator', tampered);
  const ver = await R.verify('estimator');
  t.ok('verify detects direct mutation', ver.ok === false && ver.brokenAt === 2 && ver.reason === 'TAMPERED');
  t.ok('ledger cross-check detects mutation', (await R.verifyAgainstLedger('estimator')).ok === false);

  // restore clean copy for the rest
  await data.put('gov_prompt_registry', 'estimator', e);

  // ---- PII stripped from export ------------------------------------------
  const pp = await R.proposeVersion('review_request', 'Be warm.', { reason: 'customer jane@x.com complained, call 555-222-3333', evidenceCases: [] });
  await R.approveVersion(pp.proposal.proposalId, {}); // approved proposals are included in export (reason scrubbed)
  const exp = await R.export(null, {});
  const blob = JSON.stringify(exp.json);
  t.ok('export strips email/phone from evidence', blob.indexOf('jane@x.com') === -1 && blob.indexOf('555-222-3333') === -1 && blob.indexOf('[email]') !== -1);
  t.ok('export keeps version checksums + history', exp.json.registry.some((r) => r.agentId === 'estimator' && r.versions.length >= 3));
  t.ok('export audited', (await L.chain()).some((x) => x.type === 'prompt_registry_exported'));

  // ---- Phase-4 adapter end-to-end (approved proposal applies a version) ---
  await data.put('gov_improvement_tasks', 'tk1', { taskId: 'tk1', agentId: 'review_request', issue: 'too generic', recommendedChange: 'Add the customer first name token.', sourceTrainingCases: [] });
  const cp = await P.createProposal({ taskId: 'tk1', proposedChange: 'NEW review prompt v-governed' });
  await P.submit(cp.proposal.proposalId, {});
  await P.approve(cp.proposal.proposalId, { note: 'Reviewed and safe to ship now.', checklistConfirmed: true, rollbackNote: 'Restore generic prompt.' });
  const impl = await P.implement(cp.proposal.proposalId, {});
  t.ok('phase-4 implement applies via registry', impl.ok === true && impl.applied === true);
  t.eq('registry now serves the governed review prompt', await R.getCurrent('review_request'), 'NEW review prompt v-governed');
  t.ok('registry entry links the source phase-4 proposal', (await R.history('review_request')).some((v) => v.sourceProposalId === cp.proposal.proposalId));

  t.ok('audit ledger verifies', (await L.verify()).ok === true);
  return t.report();
};
