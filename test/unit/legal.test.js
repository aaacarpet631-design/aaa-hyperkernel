/* Legal Intelligence Division — store doctrine (AI-block, versioned history, RBAC) + risk contract. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('legal');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/legal/legal-store.js');
  load('js/legal/legal-risk-engine.js');
  const L = G.AAA_LEGAL_STORE;
  const R = G.AAA_LEGAL_RISK;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  // --- doctrine: AI is hard-blocked from creating BINDING legal records ---
  RB.setRole('owner');
  t.eq('AI cannot create a contract record', (await L.add('contract', { value: 5000 }, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  t.eq('AI cannot file an incident', (await L.add('incident', {}, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  // ...but the ONE AI-allowed action is preparing an attorney-review package.
  const prep = await L.add('legal_review', { question: 'review this contract' }, { origin: 'ai', author: 'clio' });
  t.ok('AI may prepare a legal-review package', prep.ok === true && prep.record.type === 'legal_review');
  t.ok('AI prep was audited (PREPARE_LEGAL_REVIEW)', (await GW.recentAudit(100)).some((a) => a.action === 'PREPARE_LEGAL_REVIEW' && a.decision === 'allowed' && a.origin === 'ai'));

  // --- RBAC: crew cannot record legal facts; owner/manager can ---
  RB.setRole('crew');
  t.eq('crew cannot add a legal record', (await L.add('contract', {}, { author: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const rec = await L.add('contract', { value: 5000 }, { title: 'Install contract', summary: 'signed', author: 'owner' });
  t.ok('owner can record a legal fact', rec.ok === true && rec.record.version === 1 && rec.record.type === 'contract');
  t.ok('human legal write audited (ADD_LEGAL_RECORD allowed)', (await GW.recentAudit(100)).some((a) => a.action === 'ADD_LEGAL_RECORD' && a.decision === 'allowed'));
  t.eq('crew add was audited as denied', (await GW.recentAudit(100)).filter((a) => a.action === 'ADD_LEGAL_RECORD' && a.decision === 'denied').length >= 1, true);

  // --- versioned, append-only history: revise never loses prior state ---
  const id = rec.record.id;
  t.ok('initial history has one version', rec.record.history.length === 1 && rec.record.history[0].version === 1);
  const rev = await L.revise(id, { summary: 'updated — addendum signed', status: 'active' }, { author: 'owner' });
  t.ok('revise bumps version to 2', rev.ok === true && rev.record.version === 2);
  t.ok('history is append-only (2 entries)', rev.record.history.length === 2);
  t.ok('prior state snapshotted into history', rev.record.history[1].snapshot && rev.record.history[1].snapshot.summary === 'signed');
  t.eq('current summary updated', rev.record.summary, 'updated — addendum signed');

  // --- risk engine returns the EXACT standard contract ---
  const empty = await R.companyRisk();
  const keys = ['risk_score', 'severity', 'contributing_factors', 'mitigation_actions', 'escalation_required', 'categories'];
  t.ok('risk contract has all required keys', keys.every((k) => k in empty));
  t.ok('absent data scores LOW (never invented)', empty.risk_score === 0 && empty.escalation_required === false && Array.isArray(empty.contributing_factors));
  t.ok('categories cover the six areas', ['contract', 'payment', 'compliance', 'employment', 'documentation', 'reputation'].every((c) => c in empty.categories));

  // --- risk reflects a real open incident tied to a job ---
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', currentState: 'IN_PROGRESS' });
  await L.add('incident', { detail: 'water damage claim' }, { author: 'owner', title: 'Incident', links: { jobId: 'j1' }, status: 'open' });
  const after = await R.companyRisk();
  t.ok('an open incident raises company risk', after.risk_score > empty.risk_score);
  t.ok('the incident becomes a contributing factor', after.contributing_factors.length >= 1 && typeof after.escalation_required === 'boolean');

  return t.report();
};
