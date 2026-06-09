/*
 * Phase 6 — agent-os reads governed prompts from the registry, with safe
 * fallback. Verifies a generic sub-agent uses the registry's active version
 * once applied, and its built-in prompt when none exists (no breakage).
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('agent-os-governed-prompt');
  const { G } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1' } });
  G.AAA_CONFIG.isProxyConfigured = function () { return true; };

  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/agents/agent-registry.js');
  load('js/governance/prompt-registry.js');
  load('js/agents/agent-os.js');
  const R = G.AAA_PROMPT_REGISTRY, OS = G.AAA_AGENT_OS, REG = G.AAA_AGENTS;

  // capture the system prompt agent-os sends; return a valid decision
  let lastSystem = null;
  G.AAA_DATA.callAgent = async function (payload) { lastSystem = payload.system; return { ok: true, text: JSON.stringify({ recommendation: 'do x', rationale: 'because', confidence: 70 }) }; };
  G.AAA_DATA.logDecision = async function () { return { id: 'dec_1' }; };

  // fallback: no governed prompt → built-in system prompt is used
  const builtIn = REG.get('operations').system;
  await OS.runAgent('operations', 'plan the week', {});
  t.eq('falls back to built-in prompt when no registry entry', lastSystem, builtIn);

  // apply a governed prompt for 'sales' through the pipeline
  const p = await R.proposeVersion('sales', 'GOVERNED SALES PROMPT', {});
  await R.approveVersion(p.proposal.proposalId, {});
  await R.applyVersion(p.proposal.proposalId, { checklistConfirmed: true, rollbackNote: 'revert' });

  await OS.runAgent('sales', 'close the deal', {});
  t.eq('agent-os uses the governed prompt once applied', lastSystem, 'GOVERNED SALES PROMPT');

  // a different ungoverned agent still uses its built-in prompt
  const opsBuiltIn = REG.get('operations').system;
  await OS.runAgent('operations', 'again', {});
  t.eq('ungoverned agent unaffected', lastSystem, opsBuiltIn);

  return t.report();
};
