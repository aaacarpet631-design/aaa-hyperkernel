/*
 * Agent Scorecards — metric math + drift/breach detection + recompute pipeline
 * (persist, score_changed audit, breach escalation) + dashboard insights.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('agent-scorecards');
  const { G, cfg, data } = setupEnv({ config: { role: 'owner', governanceEscalationCooldownMs: 1000, govMinSample: 5 } });
  let T = 1000000;
  G.AAA_RUNTIME_CLOCK = { now: () => T, nowISO: () => new Date(T).toISOString() };
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  load('js/governance/agent-outcomes.js');
  load('js/governance/agent-scorecards.js');
  const SC = G.AAA_AGENT_SCORECARDS;
  const O = G.AAA_AGENT_OUTCOMES;
  const L = G.AAA_AUDIT_LEDGER;

  // ---- pure computeScorecard ---------------------------------------------
  const decs = [
    { outcomeStatus: 'successful', confidence: 0.9, outcome: { value: 1000 } },
    { outcomeStatus: 'successful', confidence: 0.9, outcome: { value: 1000 } },
    { outcomeStatus: 'successful', confidence: 0.9, outcome: { value: 1000 } },
    { outcomeStatus: 'unsuccessful', confidence: 0.8, outcome: { value: 500 } },
    { outcomeStatus: 'overridden', confidence: 0.7 },
    { outcomeStatus: 'pending' },
    { outcomeStatus: 'abandoned' }
  ];
  const c = SC.computeScorecard('quote', decs);
  t.eq('accuracy = succ/binary', c.accuracy, 0.75);
  t.eq('successRate = succ/considered', c.successRate, 0.6);
  t.eq('overrideRate = overridden/considered', c.overrideRate, 0.2);
  t.eq('avg confidence', c.averageConfidence, 0.84);
  t.ok('calibration ~0.833', Math.abs(c.confidenceCalibration - 0.833) < 0.002);
  t.eq('revenue influenced', c.revenueInfluenced, 3000);
  t.eq('roi impact = rev - loss', c.roiImpact, 2500);
  t.eq('false positive rate', c.falsePositiveRate, 1);
  t.eq('false negative rate', c.falseNegativeRate, 0);
  t.eq('resolved sample', c.samples.resolved, 4);

  // thin sample → null metrics, never falsely "bad"
  const thin = SC.computeScorecard('new', [{ outcomeStatus: 'pending' }]);
  t.ok('thin → null accuracy', thin.accuracy === null && thin.successRate === null);

  // ---- computeDrift -------------------------------------------------------
  const driftDecs = [];
  for (let i = 0; i < 3; i++) driftDecs.push({ outcomeStatus: 'successful', updatedAt: 100 });       // prior, acc 1.0
  for (let i = 0; i < 2; i++) driftDecs.push({ outcomeStatus: 'unsuccessful', updatedAt: 9500 });    // recent
  driftDecs.push({ outcomeStatus: 'successful', updatedAt: 9500 });                                   // recent, acc 0.33
  const drift = SC.computeDrift(driftDecs, 10000, 1000, 3, 0.15);
  t.ok('drift detected (1.0 → 0.33)', drift && drift.drifting === true && drift.prior === 1 && Math.abs(drift.recent - 0.333) < 0.01);

  // ---- detectBreaches -----------------------------------------------------
  const th = SC.thresholds();
  const bad = { samples: { considered: 10 }, accuracy: 0.4, overrideRate: 0.5, confidenceCalibration: 0.4, roiImpact: 200 };
  const breaches = SC.detectBreaches(bad, { roiImpact: 1000 }, th);
  const metrics = breaches.map((b) => b.metric);
  t.ok('accuracy breach', metrics.indexOf('accuracy') !== -1);
  t.ok('override breach', metrics.indexOf('overrideRate') !== -1);
  t.ok('calibration breach', metrics.indexOf('confidenceCalibration') !== -1);
  t.ok('roi drop breach (1000 → 200)', metrics.indexOf('roiImpact') !== -1);
  t.ok('thin sample → no breaches', SC.detectBreaches({ samples: { considered: 2 }, accuracy: 0.1 }, null, th).length === 0);

  // materiallyChanged
  t.ok('no prev → changed', SC.materiallyChanged(null, c) === true);
  t.ok('same → unchanged', SC.materiallyChanged(c, c) === false);
  t.ok('accuracy move → changed', SC.materiallyChanged({ accuracy: 0.75 }, { accuracy: 0.9 }) === true);

  // ---- recompute pipeline (persist + score_changed + breach escalation) ---
  for (let i = 0; i < 6; i++) {
    const dd = (await O.recordDecision({ agentId: 'est-1', agentType: 'estimator', confidence: 0.8 })).decision;
    await O.attachOutcome(dd.decisionId, { result: 'lost_job', value: 400 }); // all fail → low accuracy
  }
  const rc = await SC.recompute('estimator');
  t.ok('scorecard persisted', !!(await SC.get('estimator')));
  t.ok('score_changed audited', (await L.chain()).some((e) => e.type === 'score_changed' && e.payload.agentType === 'estimator'));
  t.ok('accuracy breach raised an escalation', rc.escalations.some((e) => e.kind === 'agent_accuracy'));
  const escs = await G.AAA_GOVERNANCE_ESCALATION.list();
  t.ok('breach escalation persisted + open', escs.some((e) => e.category === 'estimator' && e.status === 'open' && e.metric === 'accuracy'));
  t.ok('audit ledger verifies', (await L.verify()).ok === true);

  // ---- insights -----------------------------------------------------------
  const ins = await SC.insights();
  t.ok('estimator surfaces as needing retraining', ins.needingRetraining.some((x) => x.agentType === 'estimator'));

  return t.report();
};
