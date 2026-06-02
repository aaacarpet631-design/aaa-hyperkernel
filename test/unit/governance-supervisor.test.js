/*
 * Governance Supervisor foundation — recommendations only, audited, no
 * autonomous changes (no network).
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-supervisor');
  const { G, data } = setupEnv({ config: { govMinSample: 5 } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/agent-outcomes.js');
  load('js/governance/agent-scorecards.js');
  load('js/governance/governance-supervisor.js');
  const S = G.AAA_GOVERNANCE_SUPERVISOR;
  const L = G.AAA_AUDIT_LEDGER;

  // no scorecard yet
  t.eq('no scorecard → error', (await S.review('ghost')).error, 'NO_SCORECARD');

  // Seed a poor scorecard directly.
  await data.put('gov_agent_scorecards', 'quote', {
    agentType: 'quote', samples: { considered: 12 },
    accuracy: 0.4, successRate: 0.4, overrideRate: 0.5, confidenceCalibration: 0.4,
    roiImpact: -100, drift: { drifting: true, prior: 0.8, recent: 0.5 }
  });

  const r = await S.review('quote');
  t.ok('review ok', r.ok === true);
  const types = r.recommendations.map((x) => x.type);
  t.ok('recommends prompt review (low accuracy)', types.indexOf('review_prompt') !== -1);
  t.ok('recommends recalibration', types.indexOf('recalibrate_confidence') !== -1);
  t.ok('recommends guardrail review (overrides)', types.indexOf('review_guardrail') !== -1);
  t.ok('recommends pause (negative ROI)', types.indexOf('pause_and_review') !== -1);
  t.ok('recommends drift investigation', types.indexOf('investigate_drift') !== -1);

  // Each recommendation audited as retraining_recommendation, flagged non-autonomous.
  const recAudits = (await L.chain()).filter((e) => e.type === 'retraining_recommendation');
  t.ok('recommendations audited', recAudits.length === r.recommendations.length && recAudits.length >= 5);
  t.ok('audit marks autonomous=false', recAudits.every((e) => e.payload.autonomous === false));

  // Persisted as proposals, not applied.
  const stored = await S.recommendations();
  t.ok('proposals stored as non-autonomous', stored.length >= 5 && stored.every((x) => x.status === 'proposed' && x.autonomous === false));

  // Autonomous changes are disabled.
  t.eq('applyChange refuses', (await S.applyChange()).error, 'AUTONOMOUS_CHANGES_DISABLED');

  // Future supervisor analyzers can contribute.
  S.registerAnalyzer(function () { return [{ type: 'custom_signal', severity: 'low', metric: 'x', value: 1, reason: 'demo', suggestedAction: 'noop' }]; });
  const r2 = await S.review('quote');
  t.ok('registered analyzer contributes', r2.recommendations.some((x) => x.type === 'custom_signal'));

  return t.report();
};
