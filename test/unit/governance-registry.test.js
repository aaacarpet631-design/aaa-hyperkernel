/* Governance Registry — versioned lifecycle, approval gate, rollback, checksum chain, audit. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance-registry');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/governance-registry.js');
  const R = G.AAA_GOVERNANCE;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // --- create draft: only content-accepting API, chains a checksum ---
  const d = await R.createDraft('prompt', 'pricing_optimizer', 'You are the pricing optimizer. v1 text.', { actor: 'owner' });
  t.ok('createDraft returns a draft version', d.ok === true && d.version.status === 'draft' && d.version.version === 1);
  t.ok('draft has a checksum + null prevChecksum', !!d.version.checksum && d.version.prevChecksum === null);
  t.ok('draft records createdBy + auditRef', d.version.createdBy === 'owner' && !!d.version.auditRef);
  t.eq('bad artifact type rejected', (await R.createDraft('nonsense', 'x', 'y')).error, 'BAD_ARTIFACT_TYPE');
  t.eq('name required', (await R.createDraft('prompt', '', 'y')).error, 'NAME_REQUIRED');

  // --- lifecycle: draft → proposed → approved → active ---
  const v1 = d.version;
  t.eq('cannot activate a draft', (await R.activate(v1.id)).error, 'NOT_APPROVED');
  t.eq('cannot approve a draft (must propose first)', (await R.approve(v1.id)).error, 'BAD_TRANSITION');
  t.ok('propose moves draft → proposed', (await R.propose(v1.id, { actor: 'owner' })).version.status === 'proposed');
  const appr = await R.approve(v1.id, { actor: 'owner' });
  t.ok('approve moves proposed → approved + records approver', appr.version.status === 'approved' && appr.version.approvedBy === 'owner' && !!appr.version.approvedAt);
  t.ok('no active version until activation', (await R.getActive('prompt', 'pricing_optimizer')) === null);
  const act = await R.activate(v1.id, { actor: 'owner' });
  t.ok('activate moves approved → active', act.version.status === 'active' && !!act.version.activatedAt);
  t.eq('getActive returns the active version', (await R.getActive('prompt', 'pricing_optimizer')).id, v1.id);

  // --- a second version supersedes the first on activation ---
  const d2 = await R.createDraft('prompt', 'pricing_optimizer', 'You are the pricing optimizer. v2 improved.', { actor: 'owner' });
  t.ok('v2 chains onto v1 checksum', d2.version.version === 2 && d2.version.prevChecksum === v1.checksum);
  await R.propose(d2.version.id, { actor: 'owner' });
  await R.approve(d2.version.id, { actor: 'owner' });
  await R.activate(d2.version.id, { actor: 'owner' });
  t.eq('getActive now returns v2', (await R.getActive('prompt', 'pricing_optimizer')).version, 2);
  t.eq('prior active is deprecated', (await R.get(v1.id)).status, 'deprecated');

  // --- history + checksum chain integrity ---
  const hist = await R.listHistory('prompt', 'pricing_optimizer');
  t.ok('history lists every version (append-only)', hist.length === 2);
  const chain = await R.verifyChecksumChain('prompt', 'pricing_optimizer');
  t.ok('checksum chain is intact', chain.ok === true && chain.length === 2 && chain.breaks.length === 0);

  // --- tamper detection: silently editing stored content breaks the chain ---
  const tampered = Object.assign({}, await R.get(v1.id), { content: 'HACKED — replaced after approval' });
  await data.put('governance_versions', v1.id, tampered); // bypass the API entirely
  const broken = await R.verifyChecksumChain('prompt', 'pricing_optimizer');
  t.ok('tampered content is detected by the chain', broken.ok === false && broken.breaks.some((b) => b.id === v1.id && b.reason === 'checksum_mismatch'));
  // restore for the rollback test
  await data.put('governance_versions', v1.id, Object.assign({}, tampered, { content: 'You are the pricing optimizer. v1 text.' }));

  // --- no silent mutation: a transition never rewrites content/checksum ---
  const beforeV2 = await R.get(d2.version.id);
  await R.deprecate(d2.version.id, { actor: 'owner' });
  const afterV2 = await R.get(d2.version.id);
  t.ok('deprecate changes status only, not content/checksum', afterV2.status === 'deprecated' && afterV2.content === beforeV2.content && afterV2.checksum === beforeV2.checksum);

  // --- rollback: append-only new active, prior marked rolled_back, reversible ---
  // Re-activate v1 cleanly, then roll back.
  const d3 = await R.createDraft('prompt', 'pricing_optimizer', 'v3 current', { actor: 'owner' });
  await R.propose(d3.version.id, { actor: 'owner' }); await R.approve(d3.version.id, { actor: 'owner' }); await R.activate(d3.version.id, { actor: 'owner' });
  const rb = await R.rollback('prompt', 'pricing_optimizer', { actor: 'owner' });
  t.ok('rollback creates a NEW active version', rb.ok === true && rb.version.status === 'active' && rb.version.id !== d3.version.id);
  t.ok('rollback links rollbackFrom + clones prior content', rb.version.rollbackFrom === d3.version.id && typeof rb.version.content === 'string');
  t.eq('the rolled-back version is marked rolled_back', (await R.get(d3.version.id)).status, 'rolled_back');
  t.eq('nothing-active rollback is honest', (await R.rollback('model', 'unknown_agent', { actor: 'owner' })).error, 'NOTHING_ACTIVE');

  // --- artifacts() summary groups by key ---
  await R.createDraft('model', 'pricing_optimizer', 'claude-opus-4-8', { actor: 'owner' });
  const arts = await R.artifacts();
  t.ok('artifacts groups distinct keys', arts.length === 2 && arts.some((a) => a.artifactType === 'model') && arts.some((a) => a.artifactType === 'prompt'));

  // --- security: AI blocked, crew/manager forbidden, every attempt audited ---
  const probe = await R.createDraft('policy', 'refund_window', 'within 7 days', { actor: 'owner' }); // valid-state draft to probe the gate
  t.eq('AI cannot govern the registry', (await R.createDraft('prompt', 'x', 'y', { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('manager');
  t.eq('manager cannot govern (owner-only)', (await R.createDraft('prompt', 'x', 'y', { actor: 'mgr' })).error, 'FORBIDDEN');
  RB.setRole('crew');
  t.eq('crew cannot propose (owner-only)', (await R.propose(probe.version.id, { actor: 'crew' })).error, 'FORBIDDEN');
  t.ok('crew denial did not change the draft', (await R.get(probe.version.id)).status === 'draft');
  RB.setRole('owner');
  const audit = await GW.recentAudit(200);
  t.ok('governance actions are audited (GOVERN_REGISTRY)', audit.some((a) => a.action === 'GOVERN_REGISTRY' && a.decision === 'allowed') && audit.some((a) => a.action === 'GOVERN_REGISTRY' && a.decision === 'denied'));

  return t.report();
};
