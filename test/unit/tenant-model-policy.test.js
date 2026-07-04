/* Tenant Model Policy — per-tenant model routing, fail-closed.
 *
 * Guards the honest contract: no policy → seam inactive (passthrough); an
 * allowlist means exactly what it says (substitute to the best allowed model
 * or return an AUDITED NO_ALLOWED_MODEL — never a quiet fallback); residency
 * fails closed on unknown models; restricted markets are refused
 * case-insensitively; policy writes are RBAC-gated (owner/governance only);
 * and the agent-os seam refuses BEFORE the provider is called. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('tenant-model-policy');
  const { G, cfg } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/ai/tenant-model-policy.js');
  const TP = G.AAA_TENANT_MODEL_POLICY, LED = G.AAA_AUDIT_LEDGER;

  // ===== no policy → passthrough (additive seam, not a rewrite) =====
  const p0 = await TP.pick('claude-opus-4-8');
  t.ok('no policy → preferred model passes through', p0.ok === true && p0.model === 'claude-opus-4-8' && p0.policy === false);
  t.ok('no policy → any market allowed', (await TP.marketAllowed('DE')).ok === true);

  // ===== allowlist substitution =====
  const set1 = await TP.setPolicy({ allowedModels: ['claude-sonnet-4-6'], note: 'sonnet-only tenant' });
  t.ok('owner can set a policy', set1.ok === true);
  const p1 = await TP.pick('claude-opus-4-8');
  t.ok('disallowed preferred → best allowed substitute', p1.ok === true && p1.model === 'claude-sonnet-4-6' && p1.substituted === true);
  const p2 = await TP.pick('claude-sonnet-4-6');
  t.ok('allowed preferred stays put', p2.ok === true && p2.substituted === false);

  // ===== fail closed: nothing allowed → audited denial =====
  await TP.setPolicy({ allowedModels: ['some-approved-onprem-model'] });
  const p3 = await TP.pick('claude-opus-4-8');
  t.ok('no allowed model → NO_ALLOWED_MODEL with denial detail', p3.ok === false && p3.error === 'NO_ALLOWED_MODEL' && p3.denial.workspaceId === 'ws_test');
  const denials = (await G.AAA_DATA.list('governance_audit')).filter((e) => e.type === 'tenant.model.denied');
  t.ok('the denial is audited (observable)', denials.length === 1);
  t.ok('the audit chain verifies', (await LED.verify()).ok === true);

  // ===== denylist beats allowlist-absence =====
  await TP.setPolicy({ deniedModels: ['claude-opus-4-8'] });
  const p4 = await TP.pick('claude-opus-4-8');
  t.ok('denied model is substituted away', p4.ok === true && p4.model !== 'claude-opus-4-8' && p4.substituted === true);

  // ===== residency =====
  t.ok('global-region models satisfy any residency', TP.evaluate('claude-opus-4-8', { residency: 'eu' }).allowed === true);
  TP.registerModelRegions('us-only-model', ['us']);
  t.ok('region-bound model refused for other residency', TP.evaluate('us-only-model', { residency: 'eu' }).allowed === false);
  t.ok('unknown model + residency fails CLOSED', TP.evaluate('mystery-model', { residency: 'eu' }).allowed === false);
  t.ok('registerModelRegions validates', TP.registerModelRegions('x', []).ok === false);

  // ===== restricted markets =====
  await TP.setPolicy({ restrictedMarkets: ['RU', 'kp'] });
  const mk = await TP.marketAllowed('ru');
  t.ok('restricted market refused case-insensitively', mk.ok === false && mk.error === 'MARKET_RESTRICTED');
  t.ok('the market denial is audited', (await G.AAA_DATA.list('governance_audit')).some((e) => e.type === 'tenant.market.denied'));
  t.ok('unrestricted market passes', (await TP.marketAllowed('DE')).ok === true);

  // ===== RBAC: only governance-permitted roles write policy =====
  cfg.set({ role: 'crew' });
  t.eq('crew cannot set policy', (await TP.setPolicy({ deniedModels: [] })).error, 'FORBIDDEN');
  t.eq('crew cannot clear policy', (await TP.clearPolicy()).error, 'FORBIDDEN');
  cfg.set({ role: 'owner' });
  t.ok('owner can clear the policy', (await TP.clearPolicy()).ok === true);
  t.ok('after clear, passthrough again', (await TP.pick('claude-opus-4-8')).policy === false);
  t.eq('empty allowlist is a bad policy, refused', (await TP.setPolicy({ allowedModels: [] })).error, 'BAD_POLICY');

  // ===== the agent-os seam: refusal happens BEFORE the provider call =====
  load('js/agents/agent-registry.js');
  load('js/agents/model-router.js');
  load('js/agents/agent-os.js');
  let providerCalls = 0;
  G.AAA_CONFIG.isProxyConfigured = () => true;
  G.AAA_DATA.callAgent = async (payload) => {
    providerCalls++;
    return { ok: true, text: JSON.stringify({ recommendation: 'do x', rationale: 'because', confidence: 80, risks: [], next_actions: [] }), model: payload.model };
  };
  await TP.setPolicy({ allowedModels: ['claude-haiku-4-5'] });
  const run1 = await G.AAA_AGENT_OS.runAgent('sales', 'classify this lead', {});
  t.ok('allowed substitute flows through to the provider', run1.ok === true && run1.model === 'claude-haiku-4-5' && providerCalls === 1);
  await TP.setPolicy({ allowedModels: ['some-approved-onprem-model'] });
  const run2 = await G.AAA_AGENT_OS.runAgent('sales', 'classify this lead', {});
  t.ok('tenant denial refuses the run', run2.ok === false && run2.error === 'NO_ALLOWED_MODEL_FOR_TENANT');
  t.eq('and the provider was NEVER called for the denied run', providerCalls, 1);

  return t.report();
};
