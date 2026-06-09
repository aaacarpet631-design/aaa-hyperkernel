/* Calibration runtime — cold boot restore, agent consumption, upgrade path, missing state. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function loadCore(G) {
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/agent-registry.js');
  load('js/agents/supervisor.js');
  load('js/agents/estimator-agent.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js');
  load('js/intelligence/prediction-closure.js');
  load('js/intelligence/calibration-registry.js');
}

module.exports = async function run() {
  const t = makeRunner('calibration-runtime');

  // ---- 1) Cold boot / restore: an active version persisted, then rehydrated ----
  {
    const { G, data } = setupEnv();
    loadCore(G);
    await data.put('calibration_versions', 'cv1', { id: 'cv1', agent: 'pricing_optimizer', version: 1, active: true, confidenceBias: 8, riskBias: -3, segmentAdjustments: [], workspaceId: 'ws_test' });
    const before = G.AAA_AGENTS.getTuning('pricing_optimizer');
    const res = await G.AAA_CALIBRATION_REGISTRY.rehydrate();
    t.ok('cold boot: nothing applied before rehydrate', before === null);
    t.ok('rehydrate restores active calibration', res.ok === true && res.applied === 1);
    t.eq('approved calibration survives restart', G.AAA_AGENTS.getTuning('pricing_optimizer').confidenceBias, 8);

    // Optimizer consumes the restored bias.
    let n = 0; const q = (f) => { n++; const id = 'q' + n; return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', serviceType: ['carpet_install'], zip: '77005', leadSource: 'google', customerTotal: 1500, marginPct: 30, risk: 20, finalPrice: null, resolvedAt: '2026-05-10' }, f)); };
    await q({ status: 'lost' }); await q({ status: 'lost' }); await q({ status: 'lost' });
    const a = await G.AAA_PRICING_OPTIMIZER.analyze();
    const rec = a.recommendations.find((r) => r.type === 'weak_lead_source' && r.segment === 'google');
    t.ok('optimizer consumes restored calibration bias', rec && rec.registryBias === 8);

    // No price/customer mutation from rehydrate.
    t.ok('rehydrate wrote no rate card / customer record', !data._store.rate_cards && !data._store.customers);
  }

  // ---- 2) Estimator consumes confidence + risk bias ----
  {
    const { G, data } = setupEnv();
    loadCore(G);
    await data.put('calibration_versions', 'cv2', { id: 'cv2', agent: 'estimator', version: 1, active: true, confidenceBias: 7, riskBias: 4, segmentAdjustments: [], workspaceId: 'ws_test' });
    await G.AAA_CALIBRATION_REGISTRY.rehydrate();
    const sessions = [G.AAA_MEASUREMENT_MODELS.newSession({ roomName: 'Living', length: 14, width: 12 })];
    const est = G.AAA_ESTIMATOR.estimate({ sessions: sessions, services: ['carpet_install'] });
    t.eq('estimator confidence bias applied', est.calibrationBias, 7);
    t.eq('estimator confidence = base + bias', est.confidence, clamp(est.baseConfidence + 7, 0, 100));
    t.eq('estimator risk bias applied', est.calibrationRiskBias, 4);
    t.eq('estimator risk = base + bias', est.risk, clamp(est.baseRisk + 4, 0, 100));
    // Calibration tunes confidence/risk only — the PRICE is untouched.
    const priced = G.AAA_MEASUREMENT_QUOTE.buildQuote([{ serviceId: 'carpet_install', sessions: sessions }]);
    t.eq('calibration does NOT change the quote price', est.quote.total, priced.total);
    t.eq('calibration does NOT change the customer total', est.receipt.total, priced.total);
  }

  // ---- 3) Upgrade path: older/missing-field version applies safely ----
  {
    const { G, data } = setupEnv();
    loadCore(G);
    // No riskBias, no segmentAdjustments, no schema — an older record shape.
    await data.put('calibration_versions', 'old1', { id: 'old1', agent: 'estimator', version: 1, active: true, confidenceBias: 3, workspaceId: 'ws_test' });
    const res = await G.AAA_CALIBRATION_REGISTRY.rehydrate();
    t.ok('older version applied without error', res.ok === true && res.applied === 1);
    const tun = G.AAA_AGENTS.getTuning('estimator');
    t.ok('older version maps to safe defaults', tun.confidenceBias === 3 && Array.isArray(tun.segmentAdjustments));
    const est = G.AAA_ESTIMATOR.estimate({ sessions: [G.AAA_MEASUREMENT_MODELS.newSession({ roomName: 'A', length: 10, width: 10 })], services: ['carpet_shampoo'] });
    t.eq('older version: missing riskBias treated as 0', est.calibrationRiskBias, 0);
    t.eq('older version: confidence bias still applied', est.calibrationBias, 3);
  }

  // ---- 4) Missing / malformed registry state is safe ----
  {
    const { G, data } = setupEnv();
    loadCore(G);
    // Clean baseline (this single test process shares one global across sections).
    G.AAA_AGENTS.setTuning('estimator', null); G.AAA_AGENTS.setTuning('pricing_optimizer', null);
    const none = await G.AAA_CALIBRATION_REGISTRY.rehydrate();
    t.ok('no versions → applied 0, no throw', none.ok === true && none.applied === 0);
    await data.put('calibration_versions', 'bad1', { id: 'bad1', active: true, confidenceBias: 5, workspaceId: 'ws_test' }); // no agent
    const res = await G.AAA_CALIBRATION_REGISTRY.rehydrate();
    t.ok('malformed version skipped, not applied', res.applied === 0 && res.skipped === 1);
    // Estimator with no tuning behaves at baseline (bias 0).
    const est = G.AAA_ESTIMATOR.estimate({ sessions: [G.AAA_MEASUREMENT_MODELS.newSession({ roomName: 'A', length: 10, width: 10 })], services: ['carpet_install'] });
    t.eq('no calibration → zero bias (default behavior)', est.calibrationBias, 0);
    t.eq('no calibration → confidence equals base', est.confidence, est.baseConfidence);
  }

  return t.report();
};
