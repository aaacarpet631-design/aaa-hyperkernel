/* Policy Decision Point (PDP) core — the server trust boundary's brain
 * (ATLAS Domain 1 / keystone).
 *
 * The load-bearing proof: decide() reproduces the LIVE runtime gateway's
 * decision for EVERY action x origin x role, sourced from the shared
 * governance-policy artifact — so the same decision can be enforced
 * server-side. Plus the C4 backstop: origin is derived from the principal
 * class and cannot be spoofed; an agent can never perform an aiAllowed:false
 * action whatever it claims. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('policy-decision');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/aaa-policy-contract.js');
  load('js/core/aaa-policy-decision.js');
  const PDP = G.AAA_POLICY_DECISION, GW = G.AAA_RUNTIME_GATEWAY, RBAC = G.AAA_RBAC;

  // Independent reference of the gateway's decision rule, computed from the
  // LIVE ACTIONS + MATRIX (NOT the artifact) — so this catches any divergence
  // between the PDP's use of the artifact and the gateway's real logic.
  function expected(action, origin, role) {
    const gate = GW.ACTIONS[action];
    if (!gate) return 'deny';
    if (origin === 'ai' && gate.aiAllowed !== true) return 'deny';
    if (gate.permission) {
      const perms = RBAC.MATRIX[role];
      if (!perms) return 'deny';
      if (perms.indexOf(gate.permission) === -1) return 'deny';
    }
    return 'allow';
  }

  // ===== GOLDEN FIDELITY: full action x origin x role matrix =====
  const actions = Object.keys(GW.ACTIONS);
  const roles = Object.keys(RBAC.MATRIX); // owner, manager, crew
  let checks = 0, mismatches = 0;
  actions.forEach(function (action) {
    [['human', 'human'], ['agent', 'ai']].forEach(function (pair) {
      const principalType = pair[0], origin = pair[1];
      roles.forEach(function (role) {
        const got = PDP.decide({ action: action, principalType: principalType, role: role });
        const want = expected(action, origin, role);
        checks++;
        if ((got.allow ? 'allow' : 'deny') !== want) {
          mismatches++;
          if (mismatches <= 5) console.log('   MISMATCH ' + action + '/' + origin + '/' + role + ': pdp=' + got.decision + '(' + got.reason + ') want=' + want);
        }
      });
    });
  });
  t.ok('PDP reproduces the live gateway decision for ALL ' + checks + ' (action x origin x role) cases', mismatches === 0);
  t.ok('the matrix actually exercised every action', checks === actions.length * 2 * roles.length && actions.length >= 30);

  // ===== C4 origin backstop: derived from credential, never spoofable =====
  t.eq('origin of an agent principal is ai', PDP.originOf('agent'), 'ai');
  t.eq('origin of any non-agent principal is human', PDP.originOf('owner-session'), 'human');
  // FINALIZE_PRICE is aiAllowed:false — an agent is denied even as an owner role,
  // and there is NO input by which a caller can assert human origin.
  const agentOwner = PDP.decide({ action: 'FINALIZE_PRICE', principalType: 'agent', role: 'owner' });
  t.ok('an agent principal cannot FINALIZE_PRICE even with the owner role', agentOwner.allow === false && agentOwner.reason === 'AI_NOT_PERMITTED');
  const humanOwner = PDP.decide({ action: 'FINALIZE_PRICE', principalType: 'human', role: 'owner' });
  t.ok('a human owner can FINALIZE_PRICE', humanOwner.allow === true);
  // decide() ignores any stray origin field a caller tries to smuggle in.
  const smuggled = PDP.decide({ action: 'FINALIZE_PRICE', principalType: 'agent', role: 'owner', origin: 'human' });
  t.ok('a smuggled origin:human field is ignored (origin is credential-derived)', smuggled.allow === false && smuggled.reason === 'AI_NOT_PERMITTED');

  // ===== AI-allowed actions still pass for an agent with the right role =====
  const agentRunModel = PDP.decide({ action: 'RUN_MODEL', principalType: 'agent', role: 'owner' });
  t.ok('an agent CAN RUN_MODEL (aiAllowed:true) with the required permission', agentRunModel.allow === true);
  const crewRunModel = PDP.decide({ action: 'RUN_MODEL', principalType: 'human', role: 'crew' });
  t.ok('crew is denied RUN_MODEL (lacks VIEW_ALL_JOBS) — FORBIDDEN', crewRunModel.allow === false && crewRunModel.reason === 'FORBIDDEN');

  // ===== honest edges =====
  t.ok('an unknown action is denied', PDP.decide({ action: 'HACK_THE_PLANET', principalType: 'human', role: 'owner' }).reason === 'UNKNOWN_ACTION');
  t.ok('an unknown role on a permissioned action is denied', PDP.decide({ action: 'FINALIZE_PRICE', principalType: 'human', role: 'intruder' }).reason === 'UNKNOWN_ROLE');
  const noPermAction = actions.filter(function (a) { return !GW.ACTIONS[a].permission && GW.ACTIONS[a].aiAllowed; })[0];
  if (noPermAction) t.ok('a null-permission AI-allowed action allows any role', PDP.decide({ action: noPermAction, principalType: 'human', role: 'crew' }).allow === true);

  // ===== shadow mode: surfaces client/server divergence =====
  const agree = PDP.shadowCompare({ action: 'FINALIZE_PRICE', principalType: 'human', role: 'owner' }, true);
  t.ok('shadowCompare reports a match when client agrees', agree.match === true);
  const diverge = PDP.shadowCompare({ action: 'FINALIZE_PRICE', principalType: 'agent', role: 'owner' }, true);
  t.ok('shadowCompare FLAGS a client that would have allowed what the PDP denies', diverge.match === false && diverge.pdpAllow === false && diverge.clientAllow === true);

  return t.report();
};
