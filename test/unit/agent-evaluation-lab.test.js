/* Agent Evaluation Lab — accuracy + Wilson CI, FP/FN, adoption, ROI attribution, trend. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('agent-evaluation-lab');
  const { G, data } = setupEnv();
  load('js/intelligence/agent-evaluation-lab.js');
  const LAB = G.AAA_AGENT_EVAL;

  // closures engine stub (validated/contradicted per agent)
  G.AAA_PREDICTION_CLOSURE = { closures: async () => [
    { id: 'lf1', agent: 'pricing_optimizer', predictionId: 'd1', status: 'validated' },
    { id: 'lf2', agent: 'pricing_optimizer', predictionId: 'd2', status: 'validated' },
    { id: 'lf3', agent: 'pricing_optimizer', predictionId: 'd3', status: 'contradicted' },
    { id: 'lf4', agent: 'pricing_optimizer', predictionId: 'd4', status: 'validated' },
    { id: 'lf5', agent: 'agent_council', predictionId: 'dc1', status: 'validated' }
  ] };
  // decisions with confidences (for FP/FN stratification)
  await data.put('agent_decisions', 'd1', { id: 'd1', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 80 });
  await data.put('agent_decisions', 'd2', { id: 'd2', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 40 }); // unsure → validated = FN
  await data.put('agent_decisions', 'd3', { id: 'd3', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 75 }); // confident → contradicted = FP
  await data.put('agent_decisions', 'd4', { id: 'd4', workspaceId: 'ws_test', agent: 'pricing_optimizer', confidence: 60 });
  await data.put('agent_decisions', 'dc1', { id: 'dc1', workspaceId: 'ws_test', agent: 'agent_council', confidence: 70, adopted: true, jobId: 'j1' });
  // pricing recommendation review state (adoption)
  await data.put('pricing_recommendations', 'r1', { id: 'r1', workspaceId: 'ws_test', status: 'reviewed' });
  await data.put('pricing_recommendations', 'r2', { id: 'r2', workspaceId: 'ws_test', status: 'reviewed' });
  await data.put('pricing_recommendations', 'r3', { id: 'r3', workspaceId: 'ws_test', status: 'rejected' });
  await data.put('pricing_recommendations', 'r4', { id: 'r4', workspaceId: 'ws_test', status: 'open' });
  // council attribution: an approved session on job j1 + a won quote for j1
  await data.put('council_sessions', 'cs1', { id: 'cs1', workspaceId: 'ws_test', status: 'reviewed', ownerDecision: 'approve', jobId: 'j1' });
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'won', jobId: 'j1', customerTotal: 5000, marginPct: 30 });

  // ===== pricing_optimizer scorecard =====
  const po = await LAB.scorecard('pricing_optimizer');
  t.eq('accuracy = validated/conclusive (3/4 = 75%)', po.accuracy, 75);
  t.ok('accuracy has a Wilson confidence interval', po.accuracyCI && po.accuracyCI.low < 75 && po.accuracyCI.high > 75);
  t.eq('false-positive rate (1 confident wrong of 3 confident)', po.falsePositiveRate, 33);
  t.eq('false-negative rate (1 unsure-but-right of 1 unsure)', po.falseNegativeRate, 100);
  t.eq('adoption rate (2 reviewed of 3 decided)', po.adoptionRate, 67);
  t.ok('decisions + cost computed', po.decisions === 4 && po.cost === 8);
  t.ok('ROI is null when not attributable (honest, no fake dollars)', po.roi === null && /not yet attributable/.test(po.explain.roi));
  t.ok('a composite value index is produced for ranking', typeof po.valueIndex === 'number');
  t.ok('every number is explainable', /validated/.test(po.explain.accuracy) && /adopted/.test(po.explain.adoption));

  // ===== agent_council scorecard: real revenue attribution + ROI =====
  const ac = await LAB.scorecard('agent_council');
  t.ok('council revenue influence from adopted job-linked work', ac.revenueInfluence === 5000 && ac.marginInfluence === 1500);
  t.ok('council ROI computed ($5000 / $2 cost = 2500x)', ac.roi === 2500 && /influenced revenue/.test(ac.explain.roi));

  // ===== scorecards rank every producing agent =====
  const cards = await LAB.scorecards();
  t.ok('scores every recommendation-producing agent', cards.length === 2 && cards.some((c) => c.agent === 'pricing_optimizer') && cards.some((c) => c.agent === 'agent_council'));
  t.ok('ranked by ROI (council with attribution first)', cards[0].agent === 'agent_council');

  // ===== evaluate snapshots → trend =====
  await LAB.evaluate();
  await LAB.evaluate();
  t.ok('evaluation snapshots build a trend', (await LAB.trend('pricing_optimizer')).length === 2);

  // ===== null-tolerance =====
  const empty = await LAB.scorecard('unknown_agent');
  t.ok('an agent with no data scores n/a, never throws', empty.accuracy === null && empty.roi === null && empty.decisions === 0);

  return t.report();
};
