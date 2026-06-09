/* Native Model — real logistic-regression training, explainable predict, governed promote. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('native-model');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/governance-registry.js');
  load('js/intelligence/native-model.js');
  const M = G.AAA_MODEL;
  const GOV = G.AAA_GOVERNANCE;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== insufficient data is honest =====
  t.eq('training needs enough data', (await M.train()).error, 'INSUFFICIENT_DATA');

  // Seed a learnable signal: cheaper quotes win, pricier quotes lose.
  for (let i = 0; i < 24; i++) {
    const won = Math.floor(i / 4) % 2 === 0;
    await data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', serviceType: ['carpet'], zip: '90210', leadSource: 'referral', customerTotal: (won ? 600 : 1900) + (i % 4) * 25, marginPct: 30, status: won ? 'won' : 'lost', resolvedAt: '2026-01-01' });
  }

  // ===== training fits a real model with learned weights + honest metrics =====
  const tr = await M.train({ actor: 'owner' });
  t.ok('training produces a candidate model', tr.ok === true && tr.version.status === 'candidate' && tr.version.model.weights.length === 6);
  t.ok('the model learned (high train accuracy on a separable signal)', tr.metrics.trainAccuracy >= 90);
  t.ok('honest holdout metrics are reported', typeof tr.metrics.holdoutAccuracy === 'number' && tr.metrics.holdoutSample === 6);
  const priceW = tr.weights.find((w) => w.feature === 'priceZ');
  t.ok('learned price weight is negative (pricier → less likely to win)', priceW.weight < 0 && priceW.oddsMultiplier < 1);

  // ===== determinism: same data → identical weights (reproducible) =====
  const tr2 = await M.train({ actor: 'owner' });
  t.eq('training is deterministic / reproducible', JSON.stringify(tr2.version.model.weights), JSON.stringify(tr.version.model.weights));

  // ===== predict requires an active model first =====
  t.eq('predict with no active model is honest', (await M.predict({ customerTotal: 600, marginPct: 30 })).error, 'NO_ACTIVE_MODEL');

  // ===== candidate preview ranks cheap above expensive + explains itself =====
  const cheap = await M.predict({ customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' }, { preview: true });
  const pricey = await M.predict({ customerTotal: 2000, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' }, { preview: true });
  t.ok('a cheaper quote predicts a higher win probability', cheap.ok === true && pricey.ok === true && cheap.winProbability > pricey.winProbability);
  t.ok('prediction explains itself (per-feature reasons)', cheap.reasons.length >= 1 && cheap.reasons.some((r) => r.feature === 'priceZ') && /win odds/.test(cheap.reasons[0].text));
  t.ok('preview is clearly flagged (not the live model)', cheap.source === 'candidate_preview');

  // ===== promote → governance draft (proposed, NOT active): two keys =====
  t.eq('AI cannot promote a model (governance is human-only)', (await M.promote(tr.version.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot promote a model (owner-only)', (await M.promote(tr.version.id, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const prom = await M.promote(tr.version.id, { actor: 'owner' });
  t.ok('promote files a governance draft + proposes it', prom.ok === true && !!prom.governanceVersionId);
  const gv = await GOV.get(prom.governanceVersionId);
  t.ok('the model version is proposed, not yet active', gv && gv.artifactType === 'model' && gv.status === 'proposed');
  t.ok('no model is live until activation (two-key)', (await M.activeModel()) === null);

  // ===== owner activates in the registry → it becomes the live model =====
  await GOV.approve(prom.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prom.governanceVersionId, { actor: 'owner' });
  const active = await M.activeModel();
  t.ok('the activated model is now the live brain', active && active.weights.length === 6);
  const live = await M.predict({ customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' });
  t.ok('predict now uses the ACTIVE governed model', live.ok === true && live.source === 'active' && live.winProbability > 50);

  // ===== evaluate on the holdout (honesty check) =====
  const ev = await M.evaluate(active);
  t.ok('the model can be evaluated on its holdout', ev.ok === true && ev.sample === 6 && typeof ev.accuracy === 'number');

  return t.report();
};
