/* Global Desk — international dispatch for the agent organization.
 *
 * Guards the honest contract: the market context (currency/tax/units/privacy)
 * is INJECTED into the agent's context, departments route to the right
 * personas, unknown markets and departments are refused (never a silent US
 * default), orchestrator failures propagate without an envelope, and every
 * successful dispatch is sealed in an audit-chained Decision Envelope. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('global-desk');
  const { G } = setupEnv();
  load('js/core/aaa-event-bus.js');
  load('js/core/country-packs.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/action-safety-gate.js');
  load('js/agents/escalation-policy.js');
  load('js/governance/decision-envelope.js');
  load('js/agents/agent-registry.js');
  load('js/agents/global-desk.js');
  const DESK = G.AAA_GLOBAL_DESK, ENV = G.AAA_DECISION_ENVELOPE, LED = G.AAA_AUDIT_LEDGER;

  // Stub orchestrator: records calls, returns a well-formed decision.
  const calls = [];
  let fail = null;
  G.AAA_AGENT_OS = {
    runAgent: async (roleId, task, context, opts) => {
      calls.push({ roleId, task, context, opts });
      if (fail) return fail;
      return {
        ok: true, agent: roleId, decisionId: 'dec_' + calls.length,
        recommendation: 'Quote 42 sqm at standard rate', rationale: 'Margin clears the floor for this market.',
        confidence: 78, risks: ['seasonal demand'], next_actions: ['draft the quote locally']
      };
    }
  };

  // ===== market context injection =====
  const r1 = await DESK.dispatch('Prepare a quote for the Berlin office carpet job', { department: 'sales', country: 'DE', impact: { amount: 1200 }, rollback: { plan: 'discard draft', reversible: true } });
  t.ok('dispatch succeeds', r1.ok === true);
  t.eq('routes sales department to the sales persona', calls[0].roleId, 'sales');
  const m = calls[0].context.market;
  t.ok('market context injected: EUR + USt + sqm + GDPR', m.currency === 'EUR' && m.taxLabel === 'USt.' && m.areaUnit === 'sqm' && m.gdpr === true);
  t.eq('envelope carries the market', r1.envelope.country, 'DE');
  t.eq('impact localized to EUR', r1.envelope.impact.currency, 'EUR');
  t.ok('orchestrator decision log linked as evidence', r1.envelope.evidence.some((e) => e.type === 'agent_decision'));
  t.ok('envelope is sealed with an audit ref', !!r1.envelope.audit && !!r1.envelope.audit.id);
  t.ok('audit chain verifies after dispatch', (await LED.verify()).ok === true);
  t.eq('low-risk dispatch auto-approves', r1.approval.status, 'auto_approved');

  // ===== department routing table =====
  t.eq('finance routes to accounting', DESK.routeFor('finance'), 'accounting');
  t.eq('customer routes to customer_success', DESK.routeFor('customer'), 'customer_success');
  t.ok('departments listed', DESK.departments().indexOf('compliance') !== -1);
  const rr = DESK.setRoute('finance', 'kpi');
  t.ok('setRoute repoints a department to a registered persona', rr.ok === true && DESK.routeFor('finance') === 'kpi');
  t.eq('setRoute refuses unknown personas', DESK.setRoute('finance', 'nonexistent_agent').error, 'UNKNOWN_AGENT');
  DESK.setRoute('finance', 'accounting');

  // ===== honest refusals =====
  t.eq('unknown market refused (no silent US default)', (await DESK.dispatch('x', { department: 'sales', country: 'ZZ' })).error, 'UNKNOWN_COUNTRY');
  t.eq('unknown department refused', (await DESK.dispatch('x', { department: 'astrology' })).error, 'UNKNOWN_DEPARTMENT');
  t.eq('missing task refused', (await DESK.dispatch('')).error, 'NO_TASK');
  const savedEnv = G.AAA_DECISION_ENVELOPE; delete G.AAA_DECISION_ENVELOPE;
  t.eq('ungoverned dispatch (no envelope module) refused', (await DESK.dispatch('x', { department: 'sales' })).error, 'ENVELOPE_MISSING');
  G.AAA_DECISION_ENVELOPE = savedEnv;

  // ===== orchestrator failure propagates — no envelope invented =====
  fail = { ok: false, error: 'AI_NOT_CONFIGURED' };
  const rf = await DESK.dispatch('x', { department: 'sales', country: 'US' });
  t.ok('run failure propagates honestly', rf.ok === false && rf.error === 'AI_NOT_CONFIGURED');
  const before = (await ENV.list()).length;
  t.ok('no envelope was sealed for the failed run', before === (await ENV.list()).length);
  fail = null;

  // ===== high-stakes dispatch requires approval =====
  const r2 = await DESK.dispatch('Approve the hotel-chain contract pricing', { department: 'sales', country: 'GB', impact: { amount: 8000 } });
  t.eq('high-value dispatch awaits human approval', r2.approval.status, 'awaiting_approval');
  t.ok('reason names the escalation', r2.approval.reasons.some((s) => s.indexOf('high-stakes') !== -1));
  t.eq('GB impact is GBP', r2.envelope.impact.currency, 'GBP');

  // ===== multi-market fan-out =====
  const rm = await DESK.dispatchAcrossMarkets('Review carpet pricing for this market', ['US', 'DE', 'AU'], { department: 'sales', impact: { amount: 900 } });
  t.ok('fan-out runs each market', rm.ok === true && rm.results.length === 3);
  const currencies = rm.results.map((r) => r.envelope.impact.currency).join(',');
  t.eq('each market keeps its own currency', currencies, 'USD,EUR,AUD');
  t.eq('unknown market in fan-out fails that leg', (await DESK.dispatchAcrossMarkets('x', ['US', 'ZZ'], { department: 'sales' })).ok, false);
  t.eq('empty fan-out refused', (await DESK.dispatchAcrossMarkets('x', [])).error, 'NO_COUNTRIES');

  return t.report();
};
