/* Executive Copilot — intent routing, low-confidence safety, business status,
 * simulation/goal routing, missing-data honesty, executive synthesis, morning
 * briefing, governance-protected action blocking + approval package, no
 * production mutation, UI read model, voice graceful fallback. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js',
   // read-model providers
   'js/agents/marketing-intel.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/world-model.js',
   'js/revenue/council-governance.js', 'js/revenue/demand-pulse-engine.js', 'js/revenue/neighborhood-opportunity-engine.js', 'js/revenue/competitor-intelligence.js', 'js/revenue/market-intelligence.js', 'js/revenue/review-velocity-engine.js', 'js/revenue/reputation-engine.js', 'js/revenue/referral-engine.js', 'js/revenue/revenue-intelligence-council.js', 'js/revenue/budget-physics-engine.js', 'js/revenue/revenue-dashboard.js',
   'js/innovation/adjacency-mapper.js', 'js/innovation/opportunity-registry.js', 'js/innovation/innovation-dashboard.js', 'js/innovation/experiment-scorecard.js',
   'js/simulation/simulation-ledger.js', 'js/simulation/scenario-engine.js', 'js/simulation/outcome-estimator.js', 'js/simulation/monte-carlo-engine.js', 'js/simulation/strategy-scorecard.js', 'js/simulation/simulation-governance.js', 'js/simulation/counterfactual-runner.js',
   'js/intelligence/teleological-schema.js', 'js/intelligence/goal-engine.js', 'js/intelligence/resource-allocator.js',
   'js/intelligence/causal-learning-engine.js', 'js/intelligence/causal-hypothesis-store.js', 'js/innovation/experiment-registry.js', 'js/epistemology/belief-registry.js', 'js/epistemology/scientific-discovery-council.js', 'js/epistemology/knowledge-compounding-engine.js',
   // copilot
   'js/copilot/copilot-intent-router.js', 'js/copilot/council-query-engine.js', 'js/copilot/copilot-governance-gate.js', 'js/copilot/copilot-memory-retriever.js',
   'js/copilot/executive-synthesizer.js', 'js/copilot/copilot-simulation-interface.js', 'js/copilot/copilot-goal-interface.js', 'js/copilot/morning-briefing-engine.js',
   'js/copilot/copilot-dashboard-readmodel.js', 'js/copilot/voice-input-adapter.js', 'js/copilot/executive-copilot.js', 'js/copilot/copilot-ui.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

async function seed(data) {
  const q = (id, st, total, zip, m) => data.put('quotes', id, { id: id, status: st, total: total, zip: zip, margin: m, serviceType: 'cleaning' });
  await q('q1', 'won', 1200, '77001', 0.5); await q('q2', 'won', 1300, '77001', 0.48); await q('q3', 'lost', 1250, '77001', 0.3);
  await data.put('review_requests', 'rv1', { id: 'rv1', status: 'received', rating: 5, receivedAt: iso(NOW - 86400000) });
  await data.put('world_signals', 's1', { signalId: 's1', signalType: 'close_rate', value: 0.4, confidence: 0.9, volatility: 0.08, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
  await data.put('world_signals', 's2', { signalId: 's2', signalType: 'gross_margin', value: 0.48, confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
}

module.exports = async function run() {
  const t = makeRunner('copilot');
  const { G, data } = setupEnv();
  loadAll();
  await seed(data);
  const CO = G.AAA_EXECUTIVE_COPILOT, R = G.AAA_COPILOT_INTENT_ROUTER, GATE = G.AAA_COPILOT_GOVERNANCE_GATE;
  const UI = G.AAA_COPILOT_UI, VOICE = G.AAA_VOICE_INPUT_ADAPTER, BRIEF = G.AAA_MORNING_BRIEFING_ENGINE;

  // ===== intent classification =====
  t.eq('business status intent', R.classify('How are we doing this week?').intent, 'business_status');
  t.eq('revenue intent', R.classify('How much money did we make?').intent, 'revenue_analysis');
  t.eq('simulation intent', R.classify('What happens if I raise prices 5%?').intent, 'simulation_request');
  t.eq('goal intent', R.classify('How do I add $50k per month?').intent, 'goal_request');
  t.eq('risk intent', R.classify('What are my biggest risks?').intent, 'risk_report');
  t.eq('governance action intent', R.classify('Approve and apply the price change').intent, 'governance_action');
  const route = R.classify('How are we doing this week?');
  t.ok('router returns the full contract', route.confidence > 0 && Array.isArray(route.requiredCouncils) && 'riskLevel' in route && 'governanceRequired' in route);
  t.eq('gibberish is unknown', R.classify('asdf qwerty zzz').intent, 'unknown');

  // ===== low-confidence routing: never executes, asks to clarify =====
  const low = await CO.ask('asdf qwerty zzz');
  t.ok('low-confidence/unknown asks for clarification', low.intent === 'unknown' && Array.isArray(low.answer.suggestions) && low.governanceRequired === false);

  // ===== business status query + executive synthesis =====
  const status = await CO.ask('How are we doing this week?', { now: NOW });
  t.ok('business status synthesizes an owner-level answer', status.ok && typeof status.answer.summary === 'string' && status.answer.summary.length > 0);
  t.ok('synthesis exposes the executive shape', ['keyMetrics', 'threats', 'opportunities', 'bottlenecks', 'recommendedActions', 'confidence', 'missingData'].every((k) => status.answer[k] !== undefined));
  t.ok('real metrics surface (margin/close rate from read models)', status.answer.keyMetrics.grossMargin != null || status.answer.keyMetrics.closeRate != null);

  // ===== missing data is honest =====
  t.ok('missing data is reported, not faked', Array.isArray(status.answer.missingData));
  t.ok('CAC is surfaced as missing (no spend feed)', status.answer.missingData.some((m) => /CAC/i.test(m)));

  // ===== simulation routing (no production mutation) =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes });
  const simAns = await CO.ask('What happens if I raise prices 5%?', { now: NOW });
  t.ok('simulation request routes to the Simulation Council', simAns.intent === 'simulation_request' && simAns.answer.simulation && simAns.answer.simulation.status === 'simulated');
  t.ok('simulation returns expected/best/worst + approval flag', simAns.answer.simulation.expected && simAns.answer.simulation.best && simAns.answer.simulation.worst && simAns.answer.simulation.approvalRequired === true);
  t.ok('acting on a simulation requires governance', simAns.governanceRequired === true);

  // ===== goal routing (no auto execution) =====
  const goalAns = await CO.ask('How do I add $50k per month?', { now: NOW });
  t.ok('goal request routes to the Teleological Engine', goalAns.intent === 'goal_request' && goalAns.answer.goal && goalAns.answer.goal.status === 'planned');
  t.ok('goal plan exposes target + delta + gaps + experiments', goalAns.answer.goal.target && goalAns.answer.goal.currentDelta != null && Array.isArray(goalAns.answer.goal.capabilityGaps));
  t.ok('a goal never auto-executes', goalAns.governanceRequired === true);

  // ===== governance: protected action blocked + approval package =====
  const protectedAns = await CO.ask('Change the price to $1500 and send it to the customer', { now: NOW });
  t.ok('a protected action is blocked, not performed', protectedAns.governanceRequired === true && protectedAns.interruptSignal === 'HUMAN_APPROVAL_REQUIRED');
  t.ok('an approval package is created', !!protectedAns.approvalPackage && protectedAns.approvalPackage.status === 'pending_governance');
  t.eq('the gate classifies pricing as protected', GATE.classify('change the price to 1500').category, 'pricing');
  t.ok('an unprotected analysis question is allowed through', GATE.classify('how are we doing').protected === false);

  // ===== morning briefing =====
  const brief = await BRIEF.briefing({ now: NOW });
  t.ok('briefing returns the required shape', ['date', 'revenueSnapshot', 'leadSnapshot', 'operationsSnapshot', 'risks', 'opportunities', 'bottlenecks', 'experiments', 'recommendedFocus', 'missingData'].every((k) => brief[k] !== undefined));
  t.ok('briefing operations snapshot is honest insufficient_data', brief.operationsSnapshot.status === 'insufficient_data');

  // ===== production isolation across the whole copilot =====
  t.eq('no production mutation from any copilot interaction', JSON.stringify({ quotes: data._store.quotes }), prodBefore);

  // ===== UI read model =====
  const model = await UI.renderModel({ now: NOW });
  t.ok('UI renders all five screens', ['talk', 'briefing', 'simulate', 'goals', 'observatory'].every((s) => !!model.screens[s]));
  t.ok('Talk screen offers suggested questions', model.screens.talk.suggestedQuestions.length >= 5);
  t.ok('answerCard renders a safe compact card', /cp-card/.test(UI.answerCard(status)));
  t.eq('UI mount is a no-op without a DOM', UI.mount().mounted, false);

  // ===== voice adapter graceful fallback =====
  t.eq('voice degrades to text when unsupported', VOICE.isSupported(), false);
  t.eq('voice mode is text without speech APIs', VOICE.mode(), 'text');
  t.eq('listen() falls back gracefully (no throw)', VOICE.listen(function () {}).supported, false);

  return t.report();
};
