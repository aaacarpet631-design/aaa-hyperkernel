/* HyperKernel Chat Canvas — message storage, intent routing, embedded rich
 * cards (executive briefing / simulation / goal / software factory / governance
 * approval), offline queue + replay, honest insufficient_data, and no
 * production mutation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js',
   'js/agents/marketing-intel.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/world-model.js',
   'js/revenue/council-governance.js', 'js/revenue/demand-pulse-engine.js', 'js/revenue/neighborhood-opportunity-engine.js', 'js/revenue/competitor-intelligence.js', 'js/revenue/market-intelligence.js', 'js/revenue/review-velocity-engine.js', 'js/revenue/reputation-engine.js', 'js/revenue/referral-engine.js', 'js/revenue/revenue-intelligence-council.js', 'js/revenue/budget-physics-engine.js', 'js/revenue/revenue-dashboard.js',
   'js/innovation/adjacency-mapper.js', 'js/innovation/opportunity-registry.js', 'js/innovation/innovation-dashboard.js', 'js/innovation/experiment-scorecard.js',
   'js/simulation/simulation-ledger.js', 'js/simulation/scenario-engine.js', 'js/simulation/outcome-estimator.js', 'js/simulation/monte-carlo-engine.js', 'js/simulation/strategy-scorecard.js', 'js/simulation/simulation-governance.js', 'js/simulation/counterfactual-runner.js',
   'js/intelligence/teleological-schema.js', 'js/intelligence/goal-engine.js', 'js/intelligence/resource-allocator.js',
   'js/copilot/copilot-intent-router.js', 'js/copilot/council-query-engine.js', 'js/copilot/copilot-governance-gate.js', 'js/copilot/copilot-memory-retriever.js', 'js/copilot/executive-synthesizer.js', 'js/copilot/copilot-simulation-interface.js', 'js/copilot/copilot-goal-interface.js', 'js/copilot/morning-briefing-engine.js', 'js/copilot/voice-input-adapter.js', 'js/copilot/executive-copilot.js',
   // chat canvas
   'js/copilot/chat-message-store.js', 'js/copilot/offline-chat-queue.js', 'js/copilot/chat-intent-router.js', 'js/copilot/rich-card-renderer.js',
   'js/copilot/executive-briefing-card.js', 'js/copilot/simulation-result-card.js', 'js/copilot/goal-progress-card.js', 'js/copilot/software-factory-card.js', 'js/copilot/governance-approval-card.js',
   'js/copilot/chat-canvas.js', 'js/copilot/copilot-ui.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

module.exports = async function run() {
  const t = makeRunner('chat-canvas');
  const { G, data } = setupEnv();
  loadAll();
  await data.put('quotes', 'q1', { id: 'q1', status: 'won', total: 1200, zip: '77001', margin: 0.5, serviceType: 'cleaning' });
  await data.put('quotes', 'q2', { id: 'q2', status: 'lost', total: 1100, zip: '77001', margin: 0.3, serviceType: 'cleaning' });
  await data.put('world_signals', 's1', { signalId: 's1', signalType: 'gross_margin', value: 0.5, confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
  const C = G.AAA_CHAT_CANVAS, STORE = G.AAA_CHAT_MESSAGE_STORE, Q = G.AAA_OFFLINE_CHAT_QUEUE, UI = G.AAA_COPILOT_UI, RENDER = G.AAA_RICH_CARD_RENDERER;
  Q.setOnline(true);

  // ===== message stored + intent routed =====
  const r1 = await C.send('How are we doing today?', { now: NOW });
  t.ok('user + assistant messages are stored', (await STORE.thread()).length === 2);
  t.ok('intent is routed through the Copilot router', r1.intent === 'business_status' || r1.intent === 'morning_briefing');

  // ===== executive briefing card =====
  t.eq('a status question renders an executive briefing card', r1.card.type, 'executive_briefing');
  t.ok('the briefing card has owner-level fields', typeof r1.card.summary === 'string' && Array.isArray(r1.card.opportunities) && Array.isArray(r1.card.bottlenecks));
  t.ok('briefing card renders to safe HTML', /cp-briefing/.test(RENDER.html(r1.card)));

  // ===== simulation card with expected/best/worst =====
  const sim = await C.send('Run simulation: raise repair pricing 5%', { now: NOW });
  t.eq('a what-if renders a simulation card', sim.card.type, 'simulation');
  t.ok('simulation card has expected/best/worst + approval flag', sim.card.status === 'simulated' && sim.card.cases.expected && sim.card.cases.best && sim.card.cases.worst && sim.card.approvalRequired === true);

  // ===== goal card =====
  const goal = await C.send('Create goal: add $50k/month revenue', { now: NOW });
  t.eq('a goal request renders a goal card', goal.card.type, 'goal');
  t.ok('goal card has target + delta + capability gaps + approval', goal.card.status === 'planned' && goal.card.target && goal.card.currentDelta != null && Array.isArray(goal.card.capabilityGaps) && goal.card.approvalRequired === true);

  // ===== software factory card =====
  const build = await C.send('Build a review dashboard', { now: NOW });
  t.eq('a build request renders a software factory card', build.card.type, 'software_factory');
  t.ok('factory card has spec/files/tests/PR + needs approval', build.card.spec && build.card.files.status === 'pending' && build.card.prStatus === 'not_started' && build.card.governanceRequired === true);
  t.ok('the build is proposed into governance (not executed)', !!build.card.approvalPackage && build.card.approvalPackage.status === 'pending_governance');

  // ===== governance approval card blocks a protected action =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes });
  const gov = await C.send('Change the price to $1500 and send it to the customer', { now: NOW });
  t.eq('a protected action renders a governance approval card', gov.card.type, 'governance_approval');
  t.ok('the card requires explicit approval and is not yet approved', gov.card.requiresApproval === true && gov.card.approved === false && !!gov.card.recId);
  t.eq('rendering/queuing a protected action mutates no production state', JSON.stringify({ quotes: data._store.quotes }), prodBefore);

  // ===== "approve this" surfaces the pending approval card =====
  const appr = await C.send('Approve this change', { now: NOW });
  t.ok('an approve request surfaces the pending governance card', appr.card.type === 'governance_approval' && (appr.card.status === 'pending_approval' || appr.card.status === 'nothing_pending'));

  // ===== insufficient_data shown honestly =====
  const { G: G2, data: d2 } = setupEnv();
  loadAll(); // fresh env, no data
  void d2;
  const bareSim = await G2.AAA_CHAT_CANVAS.send('what if we teleport the office', {});
  t.ok('an unmappable simulation shows insufficient_data, not a fake result', bareSim.card.type === 'text' || bareSim.card.status === 'insufficient_data' || (bareSim.card.type === 'simulation' && bareSim.card.status === 'insufficient_data'));

  // ===== offline queue stores + replays =====
  G2.AAA_OFFLINE_CHAT_QUEUE.setOnline(false);
  const offline = await G2.AAA_CHAT_CANVAS.send('How are we doing today?', {});
  t.ok('an offline message is queued (no assistant answer yet)', offline.queued === true && !offline.card);
  t.ok('the queue holds the pending message', (await G2.AAA_OFFLINE_CHAT_QUEUE.pending()).length === 1);
  G2.AAA_OFFLINE_CHAT_QUEUE.setOnline(true);
  const replay = await G2.AAA_CHAT_CANVAS.replayQueue({});
  t.ok('coming back online replays the queued message', replay.replayed === 1 && (await G2.AAA_OFFLINE_CHAT_QUEUE.pending()).length === 0);

  // ===== UI render model + DOM-guarded mount =====
  const model = await UI.chatRenderModel({});
  t.ok('chat render model exposes the thread + suggested prompts', Array.isArray(model.messages) && model.suggestedPrompts.length >= 4);
  t.ok('assistant messages carry rendered card HTML', model.messages.some(function (m) { return m.role === 'assistant' && typeof m.cardHtml === 'string'; }));
  t.eq('mountChat is a no-op without a DOM', UI.mountChat().mounted, false);

  // ===== Company Brain hook: evidence-cited answers on the unknown route =====
  let brainAsks = 0;
  G2.AAA_COMPANY_BRAIN = { ask: async () => { brainAsks++; return { ok: true, intent: 'win_rate', confidence: 'medium', answer: { headline: 'Close rate is 50% (2 of 4)', findings: [{ claim: 'Overall close rate is 50%', evidence: { source: 'outcome-learning', metric: 'winRate', value: 0.5, sample: 4 } }], caveat: null } }; } };
  const brainAns = await G2.AAA_CHAT_CANVAS.send('xyzzy gibberish quux', {});
  t.ok('an unknown-route question is answered by the Company Brain with citations',
    brainAsks === 1 && brainAns.intent === 'company_brain.win_rate' && /Close rate is 50%/.test(brainAns.card.summary) && /outcome-learning · n=4/.test(brainAns.card.summary));
  // a recognized intent with ZERO findings must not pre-empt the copilot
  G2.AAA_COMPANY_BRAIN = { ask: async () => ({ ok: true, intent: 'win_rate', confidence: 'low', answer: { headline: 'No win-rate data recorded yet.', findings: [], caveat: 'No outcomes yet.' } }) };
  const noEvidence = await G2.AAA_CHAT_CANVAS.send('xyzzy gibberish quux', {});
  t.ok('a brain answer with no findings falls through to the copilot path', String(noEvidence.intent).indexOf('company_brain') === -1);
  // the brain never sees offline messages (queue check comes first)
  G2.AAA_OFFLINE_CHAT_QUEUE.setOnline(false);
  brainAsks = 0;
  G2.AAA_COMPANY_BRAIN = { ask: async () => { brainAsks++; return { ok: true, intent: 'win_rate', confidence: 'low', answer: { headline: 'x', findings: [{ claim: 'c', evidence: { source: 's', metric: 'm', value: 1, sample: 1 } }], caveat: null } }; } };
  const offBrain = await G2.AAA_CHAT_CANVAS.send('xyzzy gibberish quux', {});
  t.ok('offline messages queue without consulting the brain', offBrain.queued === true && brainAsks === 0);
  G2.AAA_OFFLINE_CHAT_QUEUE.setOnline(true);
  await G2.AAA_CHAT_CANVAS.replayQueue({});
  delete G2.AAA_COMPANY_BRAIN;

  return t.report();
};
