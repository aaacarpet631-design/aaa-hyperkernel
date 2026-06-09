/*
 * Phase 6 — staging → production (canary) channel for the prompt registry.
 * Verifies: apply-to-staging leaves production untouched, channel-aware resolve,
 * non-admin cannot promote, promote swaps production + clears staging, history
 * preserved, audited, integrity intact.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('prompt-registry-channels');
  const { G, cfg } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1' } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-learning.js');
  load('js/governance/prompt-change-pipeline.js');
  load('js/governance/prompt-registry.js');
  const R = G.AAA_PROMPT_REGISTRY, L = G.AAA_AUDIT_LEDGER;

  async function applied(agentId, text, channel) {
    const p = await R.proposeVersion(agentId, text, {});
    await R.approveVersion(p.proposal.proposalId, {});
    return R.applyVersion(p.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'revert', channel: channel });
  }

  // production v1
  const v1 = await applied('sales', 'SALES V1');
  t.eq('v1 applied to production', v1.channel, 'production');
  t.eq('production resolves v1', await R.getCurrent('sales'), 'SALES V1');

  // staging v2 (canary) — production must stay v1
  const v2 = await applied('sales', 'SALES V2 (canary)', 'staging');
  t.eq('v2 applied to staging', v2.channel, 'staging');
  const entry = await R.entry('sales');
  t.ok('production unchanged, staging set', entry.currentVersion === 1 && entry.stagingVersion === 2);
  t.eq('getCurrent still production v1', await R.getCurrent('sales'), 'SALES V1');
  t.eq('getStaging is v2', await R.getStaging('sales'), 'SALES V2 (canary)');
  t.eq('resolve default = production', await R.resolve('sales', 'fb'), 'SALES V1');
  t.eq('resolve staging channel = v2', await R.resolve('sales', 'fb', { channel: 'staging' }), 'SALES V2 (canary)');
  t.ok('staging apply audited with channel', (await L.chain()).some((e) => e.type === 'prompt_version_applied' && e.payload.channel === 'staging' && e.payload.version === 2));

  // non-admin cannot promote
  cfg.set({ role: 'manager' });
  t.eq('manager cannot promote', (await R.promote('sales', {})).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  // promote staging → production
  const pr = await R.promote('sales', {});
  t.ok('promote succeeds', pr.ok === true && pr.version === 2);
  const after = await R.entry('sales');
  t.ok('production now v2, staging cleared', after.currentVersion === 2 && !after.stagingVersion);
  t.eq('getCurrent now v2', await R.getCurrent('sales'), 'SALES V2 (canary)');
  t.ok('promotion audited', (await L.chain()).some((e) => e.type === 'prompt_version_promoted' && e.payload.version === 2));

  // history preserved (both versions), integrity intact
  const hist = await R.history('sales');
  t.ok('history retains both versions', hist.length === 2);
  t.ok('v1 archived, v2 active', hist[0].status === 'archived' && hist[1].status === 'active');
  t.ok('checksum chain verifies across channels', (await R.verify('sales')).ok === true);
  t.ok('ledger cross-check verifies', (await R.verifyAgainstLedger('sales')).ok === true);

  // promote with no staging → NO_STAGING
  t.eq('promote without staging rejected', (await R.promote('sales', {})).error, 'NO_STAGING');

  return t.report();
};
