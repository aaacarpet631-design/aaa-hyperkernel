/* SMS Copilot — owner-only auth, routing to the Executive Copilot, governance
 * inheritance (protected action blocked), honest missing data, text-length
 * formatting, swappable provider adapters, and Event Bus logging. */
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
   'js/copilot/sms-command-router.js', 'js/copilot/sms-response-formatter.js', 'js/copilot/sms-copilot-adapter.js'].forEach(load);
}

const OWNER = '+1 (713) 555-0100';
const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

module.exports = async function run() {
  const t = makeRunner('sms-copilot');
  const { G, data } = setupEnv({ config: { ownerPhones: [OWNER] } });
  loadAll();
  await data.put('quotes', 'q1', { id: 'q1', status: 'won', total: 1200, zip: '77001', margin: 0.5, serviceType: 'cleaning' });
  await data.put('quotes', 'q2', { id: 'q2', status: 'lost', total: 1100, zip: '77001', margin: 0.3, serviceType: 'cleaning' });
  await data.put('world_signals', 's1', { signalId: 's1', signalType: 'gross_margin', value: 0.5, confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
  const SMS = G.AAA_SMS_COPILOT_ADAPTER, ROUTER = G.AAA_SMS_COMMAND_ROUTER, FMT = G.AAA_SMS_RESPONSE_FORMATTER;

  // ===== owner-only authentication =====
  t.ok('the approved owner number is recognized', ROUTER.isApproved('713-555-0100') === true && ROUTER.isApproved('+17135550100') === true);
  t.ok('an unknown number is not approved', ROUTER.isApproved('+19990001111') === false);

  // ===== approved owner can query → routes to the Executive Copilot =====
  const ans = await SMS.handleInbound({ from: OWNER, body: 'How are we doing this week?', opts: { now: NOW } });
  t.ok('approved owner gets an authorized, routed answer', ans.authorized === true && !!ans.answer && ans.answer.intent === 'business_status');
  t.ok('a text reply is produced and sent via the provider', typeof ans.response === 'string' && ans.response.length > 0 && SMS.mock.sent.length === 1 && SMS.mock.sent[0].to === OWNER);

  // ===== unknown phone is rejected (never routed, never replied to) =====
  const before = SMS.mock.sent.length;
  const rej = await SMS.handleInbound({ from: '+19990001111', body: 'How much money did we make?' });
  t.ok('unknown phone is rejected', rej.authorized === false && rej.reason === 'UNKNOWN_NUMBER');
  t.eq('a rejected number is not messaged', SMS.mock.sent.length, before);

  // ===== protected action is blocked (governance inherited) =====
  const prot = await SMS.handleInbound({ from: OWNER, body: 'Change the price to 1500 and send it to the customer' });
  t.ok('a protected action over SMS returns approval-required, not an action', prot.authorized === true && prot.answer.governanceRequired === true && prot.answer.interruptSignal === 'HUMAN_APPROVAL_REQUIRED');
  t.ok('the SMS reply asks for approval', /approval/i.test(prot.response));

  // ===== simulation over SMS =====
  const sim = await SMS.handleInbound({ from: OWNER, body: 'Run a simulation: what if I raise repair prices 5%?', opts: { now: NOW } });
  t.ok('a simulation request routes and returns a text result', sim.answer.intent === 'simulation_request' && /Revenue|approval/i.test(sim.response));

  // ===== goal over SMS =====
  const goal = await SMS.handleInbound({ from: OWNER, body: 'Create a goal: add $50k/month revenue', opts: { now: NOW } });
  t.ok('a goal request routes and returns a text plan', goal.answer.intent === 'goal_request' && /Delta|approval/i.test(goal.response));

  // ===== missing data is honest =====
  const fmtMissing = FMT.format({ ok: true, governanceRequired: false, answer: { summary: 'Margin 50%.', keyMetrics: { grossMargin: 0.5 } }, missingData: ['CAC (no spend feed)'] });
  t.ok('missing data is stated honestly in the SMS', /Missing: CAC/.test(fmtMissing));

  // ===== response is formatted for text length =====
  const longSummary = 'x'.repeat(2000);
  const capped = FMT.format({ ok: true, answer: { summary: longSummary }, missingData: [] }, { maxLen: 300 });
  t.ok('a long answer is capped to SMS length with a graceful tail', capped.length <= 300 && /open the app/.test(capped));

  // ===== provider adapter can be swapped (Twilio/Telnyx/native later) =====
  const custom = { name: 'telnyx-mock', sent: [], async send(to, body) { this.sent.push({ to: to, body: body }); return { ok: true, provider: 'telnyx' }; } };
  SMS.setProvider(custom);
  t.eq('provider can be swapped', SMS.provider(), 'telnyx-mock');
  await SMS.handleInbound({ from: OWNER, body: 'What are my biggest risks?', opts: { now: NOW } });
  t.ok('the swapped provider receives the reply', custom.sent.length === 1 && custom.sent[0].to === OWNER);
  SMS.setProvider(null);
  t.eq('provider detaches back to the mock', SMS.provider(), 'mock');

  // ===== every SMS is logged to the Event Bus =====
  const log = await G.AAA_EVENT_BUS.log();
  t.ok('inbound + outbound SMS are logged to the event bus', log.some((e) => e.type === 'sms.received') && log.some((e) => e.type === 'sms.sent'));

  // ===== no production mutation =====
  t.eq('SMS interactions mutate no production state', Object.keys(data._store.quotes).length, 2);

  return t.report();
};
