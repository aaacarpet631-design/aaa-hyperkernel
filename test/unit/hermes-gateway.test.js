/*
 * Hermes Gateway — the middleman between the app and the agents.
 *
 * Covers: deterministic routing (@mention, @team, keywords, CEO fallback),
 * gateway slash commands working without AI, honest AI_NOT_CONFIGURED, the
 * full send() relay through a stubbed AAA_AGENT_OS (session transcript,
 * channel delivery, agent_logs), history bounding, and reset.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('hermes-gateway');
  const { G, data } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });

  load('js/agents/agent-registry.js');
  load('js/agents/model-router.js');
  load('js/agents/hermes-gateway.js');
  const H = G.AAA_HERMES;
  t.ok('module loaded', !!H);

  // ---- routing (pure) ------------------------------------------------------
  t.eq('route: @mention wins', H.route('@compliance is this contract ok?').agent, 'compliance');
  t.eq('route: @team forces meeting', H.route('@team how do we grow?').meeting, true);
  t.eq('route: keyword → operations', H.route('Can the crew reschedule the Tuesday job?').agent, 'operations');
  t.eq('route: keyword → accounting', H.route('What is our margin on this invoice?').agent, 'accounting');
  t.eq('route: unknown @mention falls through to keywords/CEO', H.route('@nobody hello there').agent, 'ceo');
  t.eq('route: no match → ceo', H.route('hello there').agent, 'ceo');
  t.eq('route: default fallback is marked', H.route('hello there').fallback, true);
  t.ok('route: confident keyword match is NOT marked fallback', !H.route('crew schedule').fallback);

  // ---- status / channels -----------------------------------------------------
  t.eq('status: not ready without agent OS', H.status().ready, false);
  t.eq('status: counts registry agents', H.status().agents, G.AAA_AGENTS.ids().length);
  const bad = H.registerChannel('x', {});
  t.eq('registerChannel rejects bad handler', bad.ok, false);

  const delivered = [];
  t.eq('registerChannel ok', H.registerChannel('test', { deliver: (m) => { delivered.push(m); } }).ok, true);
  t.ok('channels lists it', H.channels().indexOf('test') !== -1);

  // ---- gateway commands (no AI needed) ----------------------------------------
  const help = await H.send({ channel: 'test', text: '/help' });
  t.eq('/help works offline', help.ok, true);
  t.ok('/help mentions /agents', help.reply.indexOf('/agents') !== -1);
  const agents = await H.send({ channel: 'test', text: '/agents' });
  t.ok('/agents lists @sales', agents.reply.indexOf('@sales') !== -1);
  const unknown = await H.send({ channel: 'test', text: '/nope' });
  t.eq('unknown command flagged', unknown.ok, false);
  t.ok('commands delivered to channel', delivered.length >= 2);

  // ---- honest failure when AI is not configured --------------------------------
  const notReady = await H.send({ channel: 'test', text: 'what is our close rate?' });
  t.eq('AI_NOT_CONFIGURED is honest', notReady.error, 'AI_NOT_CONFIGURED');

  // ---- full relay through a stubbed orchestrator --------------------------------
  const calls = [];
  G.AAA_AGENT_OS = {
    isReady: () => true,
    async runAgent(roleId, task, context) {
      calls.push({ roleId, task, context });
      return { ok: true, agent: roleId, recommendation: 'Do X for ' + roleId, rationale: 'because', confidence: 80, risks: [], next_actions: [] };
    },
    async runMeeting(topic) {
      calls.push({ meeting: topic });
      return { ok: true, topic, opinions: [{ agent: 'sales' }], decision: { recommendation: 'Team says Y', rationale: 'consensus', confidence: 70, risks: [], next_actions: [] } };
    }
  };

  delivered.length = 0;
  const res = await H.send({ channel: 'test', text: 'How do we improve our margin this month?', context: { month: '2026-06' } });
  t.eq('send ok', res.ok, true);
  t.eq('routed to accounting', res.routed.agent, 'accounting');
  t.eq('reply relayed', res.reply, 'Do X for accounting');
  t.eq('orchestrator got the task', calls[0].roleId, 'accounting');
  t.eq('context relayed', calls[0].context.month, '2026-06');
  t.eq('reply delivered to channel', delivered[0].agent, 'accounting');

  const meet = await H.send({ channel: 'test', text: '@team plan next quarter' });
  t.eq('meeting send ok', meet.ok, true);
  t.eq('meeting reply from synthesis', meet.reply, 'Team says Y');

  // ---- session transcript ---------------------------------------------------------
  const hist = await H.history('test');
  t.ok('history recorded both sides', hist.length >= 4);
  t.eq('history oldest-first user turn', hist[hist.length - 2].role, 'user');
  t.eq('history reply attributed to agent', hist[hist.length - 1].role, 'hermes');

  // bounding: flood and verify cap (40)
  for (let i = 0; i < 25; i++) await H.send({ channel: 'test', text: 'margin check ' + i });
  const bounded = await H.history('test');
  t.ok('history bounded to 40', bounded.length <= 40);

  // logging breadcrumb
  const logs = await data.list('agent_logs');
  t.ok('hermes logged routing breadcrumbs', logs.some((l) => l.agent === 'hermes'));

  // ---- LLM routing fallback -----------------------------------------------------------
  // Give the data fake a callAgent stub so classify() can run; count calls so we
  // can prove the LLM is consulted ONLY on the deterministic fallback path.
  let classifyCalls = 0;
  let stubAgent = 'marketing';
  data.callAgent = async function (payload) {
    classifyCalls++;
    t.eq('classify uses Haiku tier', payload.model, 'claude-haiku-4-5');
    return { ok: true, text: JSON.stringify({ agent: stubAgent }) };
  };

  // A message with no keyword hit would default to CEO; smart routing should
  // instead consult the model and pick its (valid) answer.
  classifyCalls = 0;
  const noKeyword = 'Should we open a second storefront downtown next year?';
  t.eq('precondition: keyword table misses → fallback', H.route(noKeyword).fallback, true);
  const smart = await H.send({ channel: 'test', text: noKeyword });
  t.eq('smart routing overrode the CEO default', smart.routed.agent, 'marketing');
  t.ok('smart routing reason names LLM', smart.routed.reason.indexOf('LLM') !== -1);
  t.eq('classify was consulted exactly once', classifyCalls, 1);

  // Deterministic matches must NOT spend a classification call.
  classifyCalls = 0;
  await H.send({ channel: 'test', text: 'What is our margin this month?' });
  t.eq('confident keyword route skips the LLM', classifyCalls, 0);

  // An invalid agent id from the model is rejected; we keep the CEO default.
  classifyCalls = 0; stubAgent = 'not_a_real_agent';
  const badvised = await H.send({ channel: 'test', text: 'Tell me something vague and unroutable please.' });
  t.eq('bad classification falls back to CEO', badvised.routed.agent, 'ceo');

  // classify() is callable directly and validates against the registry.
  stubAgent = 'compliance';
  const direct = await H.classify('is this lease agreement enforceable?');
  t.eq('classify returns a valid agent', direct.agent, 'compliance');

  // The flag disables smart routing (deterministic-only mode).
  G.AAA_CONFIG.set({ hermesSmartRouting: false });
  classifyCalls = 0; stubAgent = 'marketing';
  const off = await H.send({ channel: 'test', text: 'A completely unroutable vague question.' });
  t.eq('flag off → stays on CEO default', off.routed.agent, 'ceo');
  t.eq('flag off → no LLM call', classifyCalls, 0);
  G.AAA_CONFIG.set({ hermesSmartRouting: true });

  // ---- reset ------------------------------------------------------------------------
  await H.reset('test');
  const cleared = await H.history('test');
  t.eq('reset clears history', cleared.length, 0);

  return t.report();
};
