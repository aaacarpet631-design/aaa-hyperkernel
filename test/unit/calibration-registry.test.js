/* Calibration registry — propose, approve (apply), rollback, simulate, audit, owner-only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('calibration-registry');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/agent-registry.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js');
  load('js/intelligence/prediction-closure.js');
  load('js/intelligence/calibration-registry.js');
  const R = G.AAA_CALIBRATION_REGISTRY;
  const O = G.AAA_PRICING_OPTIMIZER;
  const A = G.AAA_AGENTS;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  // Seed 3 VALIDATED closures (→ +confidence bias) + their predictions (for simulation).
  const closures = [
    { id: 'lf1', predictionId: 'P1', segmentDim: 'leadSource', segmentKey: 'google', status: 'validated', confidenceDelta: 10 },
    { id: 'lf2', predictionId: 'P2', segmentDim: 'leadSource', segmentKey: 'google', status: 'validated', confidenceDelta: 10 },
    { id: 'lf3', predictionId: 'P3', segmentDim: 'zip', segmentKey: '77002', status: 'validated', confidenceDelta: 10 }
  ];
  for (const c of closures) await data.put('learning_feedback', c.id, Object.assign({ kind: 'closure', agent: 'pricing_optimizer', workspaceId: 'ws_test', createdAt: '2026-06-10' }, c));
  // Predictions with confidence values that are MISaligned before the bias (so simulation shows improvement).
  await data.put('agent_decisions', 'P1', { id: 'P1', agent: 'pricing_optimizer', kind: 'pricing_prediction', workspaceId: 'ws_test', confidence: 40 });
  await data.put('agent_decisions', 'P2', { id: 'P2', agent: 'pricing_optimizer', kind: 'pricing_prediction', workspaceId: 'ws_test', confidence: 60 });
  await data.put('agent_decisions', 'P3', { id: 'P3', agent: 'pricing_optimizer', kind: 'pricing_prediction', workspaceId: 'ws_test', confidence: 45 });
  // Quotes so the optimizer emits a google weak-lead-source recommendation.
  let qn = 0; const q = (f) => { qn++; const id = 'q' + qn; return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', serviceType: ['carpet_install'], zip: '77005', leadSource: 'google', customerTotal: 1500, marginPct: 30, risk: 20, finalPrice: null, resolvedAt: '2026-05-10' }, f)); };
  await q({ status: 'lost', wonLostReason: 'price' }); await q({ status: 'lost', wonLostReason: 'price' }); await q({ status: 'lost', wonLostReason: 'timing' });

  const googleConf = async () => { const a = await O.analyze(); const r = a.recommendations.find((x) => x.type === 'weak_lead_source' && x.segment === 'google'); return r ? r.adjustedConfidence : null; };

  // --- propose: builds a pending proposal, applies NOTHING ---
  const prop = await R.propose({ actor: 'owner' });
  t.ok('propose built a proposal', prop.ok === true && prop.proposals.length === 1);
  const p = prop.proposals[0];
  t.ok('proposal has confidence + risk + segment biases', p.confidenceBias === 10 && typeof p.riskBias === 'number' && p.segmentAdjustments.length >= 1 && p.status === 'pending');
  t.eq('NO auto-apply: agent tuning untouched after propose', A.getTuning('pricing_optimizer'), null);
  const before = await googleConf();

  // --- owner-only: AI + crew cannot approve ---
  RB.setRole('owner');
  t.eq('AI cannot approve calibration', (await R.approve(p.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot approve calibration', (await R.approve(p.id, { actor: 'crew' })).error, 'FORBIDDEN');
  t.eq('still no tuning after blocked attempts', A.getTuning('pricing_optimizer'), null);
  RB.setRole('owner');

  const beforeQuotes = JSON.stringify(data._store.quotes);

  // --- approve → versioned + applied + audited ---
  const appr = await R.approve(p.id, { actor: 'owner' });
  t.ok('approve ok + created a version', appr.ok === true && !!appr.versionId);
  const tun = A.getTuning('pricing_optimizer');
  t.ok('tuning applied with the approved bias', tun && tun.confidenceBias === 10 && Array.isArray(tun.segmentAdjustments));
  t.ok('approve was audited (APPLY_CALIBRATION allowed)', (await GW.recentAudit(100)).some((x) => x.action === 'APPLY_CALIBRATION' && x.decision === 'allowed'));
  t.eq('proposal marked approved', (await R.getProposal(p.id)).status, 'approved');
  const active = await R.activeVersion('pricing_optimizer');
  t.ok('active version v1', active && active.version === 1 && active.active === true);

  // --- future recommendations improve (confidence rises after approval) ---
  const after = await googleConf();
  t.ok('approved calibration lifts future recommendation confidence', before != null && after != null && after > before);

  // --- simulation: historical replay, no live change ---
  const sim = await R.simulate({ agent: 'pricing_optimizer', confidenceBias: 10 });
  t.ok('simulation runs over closures', sim.ok === true && sim.sample === 3 && sim.liveChange === false);
  t.ok('simulation shows the bias would have improved alignment', sim.afterAlignmentRate > sim.beforeAlignmentRate);
  t.ok('simulation did not change the live tuning', A.getTuning('pricing_optimizer').confidenceBias === 10);

  // --- rollback → reverts tuning, audited, new version ---
  const rb = await R.rollback('pricing_optimizer', { actor: 'owner' });
  t.ok('rollback ok', rb.ok === true);
  t.eq('tuning reverted to baseline', A.getTuning('pricing_optimizer'), null);
  t.ok('rollback audited', (await GW.recentAudit(100)).filter((x) => x.action === 'APPLY_CALIBRATION' && x.decision === 'allowed').length >= 2);
  const afterRb = await googleConf();
  t.eq('recommendation confidence returns to baseline after rollback', afterRb, before);
  const versions = await R.versions('pricing_optimizer');
  t.ok('two versions on file (apply + rollback), newest active', versions.length === 2 && versions[0].active && versions[0].rolledBack);

  // --- version comparison ---
  const cmp = await R.compare(versions[1].id, versions[0].id);
  t.ok('compare returns a bias diff', cmp.ok === true && typeof cmp.diff.confidenceBias === 'number');

  // --- no price/quote mutation through the whole flow ---
  t.eq('no quote/price mutation across approve+rollback', JSON.stringify(data._store.quotes), beforeQuotes);
  t.ok('registry exposes no price-mutation method', typeof R.changePrice === 'undefined' && typeof R.setRateCard === 'undefined');

  // --- reject path ---
  await R.propose({ actor: 'owner' });               // regenerate a pending proposal
  const rej = await R.reject(p.id, { actor: 'owner' });
  t.ok('reject ok + no version created', rej.ok === true && (await R.getProposal(p.id)).status === 'rejected');

  return t.report();
};
