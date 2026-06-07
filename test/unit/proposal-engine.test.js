/* Governed Learning Loop — proposal generation, links, simulate, approve→governance, reject retained. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('proposal-engine');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/intelligence/calibration-registry.js');
  load('js/intelligence/replay-sandbox.js');
  load('js/intelligence/proposal-engine.js');
  const E = G.AAA_PROPOSAL_ENGINE;
  const GOV = G.AAA_GOVERNANCE;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const STORE = G.AAA_PROVENANCE;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // Seed quotes where FAST follow-up clearly closes more (a learnable pattern).
  let i = 0;
  const q = (status, days) => { i++; return data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', status: status, marginPct: status === 'won' ? 30 : 0, customerTotal: 1500, sentAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-01-0' + (1 + days) + 'T00:00:00Z' }); };
  for (let k = 0; k < 5; k++) await q('won', 1);   // fast → win
  for (let k = 0; k < 1; k++) await q('lost', 1);
  for (let k = 0; k < 1; k++) await q('won', 6);   // slow → mostly lose
  for (let k = 0; k < 4; k++) await q('lost', 6);

  // ===== generate detects the pattern and files a governed proposal =====
  const gen = await E.generate();
  t.ok('a proposal is generated from the pattern', gen.ok === true && gen.created >= 1);
  const fu = (await E.list()).find((p) => p.patternKey.indexOf('followUpDays') !== -1);
  t.ok('proposal targets a governed policy change', fu && fu.proposedChange.artifactType === 'policy' && fu.proposedChange.content.followUpDays === 2);
  t.ok('proposal carries evidence + confidence + risk', fu.evidence.sample > 0 && fu.confidence > 0 && fu.riskScore >= 0 && fu.riskScore <= 100);
  t.ok('proposal lists affected systems + KPI impact + rollback path', fu.affectedSystems.length >= 1 && !!fu.expectedKpiImpact && /roll back/i.test(fu.rollbackPath));
  t.ok('proposal links to outcome events + a provenance trace', fu.links.outcomeEventIds.length >= 1 && fu.links.provenanceTraceIds.length === 1);
  t.ok('provenance trace was recorded for the proposal', (await STORE.get(fu.links.provenanceTraceIds[0])) !== null);
  t.ok('title reads like a discovered improvement', /closes \d+% more/.test(fu.title));

  // ===== generation modifies NO production state (acceptance) =====
  t.eq('no governance version exists yet', (await GOV.list({ artifactType: 'policy' })).length, 0);

  // dedupe: re-running does not duplicate the same pattern
  const gen2 = await E.generate();
  t.eq('generation is idempotent on the same pattern', gen2.created, 0);

  // ===== simulate via Replay Sandbox attaches before/after KPIs =====
  const sim = await E.simulate(fu.id, { actor: 'owner' });
  t.ok('simulation runs against a provenance trace', sim.ok === true && sim.simulation.available === true && Array.isArray(sim.simulation.kpis));
  t.ok('simulation is linked on the proposal', (await E.get(fu.id)).links.replaySimulationId != null);

  // ===== approve → creates a governance draft (proposed), audited, two-key =====
  t.eq('AI cannot approve a proposal', (await E.approve(fu.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot approve (owner-only)', (await E.approve(fu.id, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const appr = await E.approve(fu.id, { actor: 'owner' });
  t.ok('approval creates a governance draft (not yet active)', appr.ok === true && !!appr.governanceVersionId);
  const gv = await GOV.get(appr.governanceVersionId);
  t.ok('the governance version is proposed, NOT active (two-key)', gv && gv.status === 'proposed' && gv.artifactType === 'policy');
  t.ok('nothing is active in production yet', (await GOV.getActive('policy', 'sales_sla')) === null);
  t.ok('proposal records the governance link + approver', (await E.get(fu.id)).status === 'approved' && (await E.get(fu.id)).links.governanceVersionIds.indexOf(appr.governanceVersionId) !== -1);
  t.ok('approval is audited (REVIEW_PROPOSAL)', (await GW.recentAudit(100)).some((a) => a.action === 'REVIEW_PROPOSAL' && a.decision === 'allowed'));

  // ===== reject is retained as organizational learning =====
  // seed thin-margin wins to produce a margin-floor proposal
  let j = 100; const tw = () => { j++; return data.put('quotes', 'q' + j, { id: 'q' + j, quoteId: 'q' + j, workspaceId: 'ws_test', status: 'won', marginPct: 12, customerTotal: 1500, sentAt: '2026-02-01T00:00:00Z', resolvedAt: '2026-02-02T00:00:00Z' }); };
  for (let k = 0; k < 6; k++) await tw();
  await E.generate();
  const mf = (await E.list()).find((p) => p.patternKey.indexOf('marginFloor') !== -1);
  t.ok('a margin-floor proposal is generated', !!mf);
  const rej = await E.reject(mf.id, { actor: 'owner', reason: 'Strategic — we win on price here' });
  t.ok('rejection is recorded with a reason', rej.ok === true && (await E.get(mf.id)).status === 'rejected' && (await E.get(mf.id)).rejectionReason === 'Strategic — we win on price here');
  const gen3 = await E.generate();
  t.ok('a rejected pattern is NOT re-proposed (retained learning)', !(gen3.proposals || []).some((p) => p.patternKey === mf.patternKey));

  return t.report();
};
