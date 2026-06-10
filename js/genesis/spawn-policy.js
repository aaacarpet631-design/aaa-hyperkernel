/*
 * AAA Spawn Policy — the Governance Enforcer for dynamic spawns.
 *
 * Before any ephemeral agent runs, this policy validates permissions, risk,
 * and cost — the same role the Action Safety Gate plays for actions, applied
 * to AGENT CREATION. Verdicts mirror the gate's vocabulary:
 *
 *   allow           low/medium risk, within budget, schema-valid
 *   needs_approval  high risk or approvalRequired — held for a human
 *   deny            safety-rule violation, protected writes, over budget,
 *                   or an agent trying to spawn an agent without the Council
 *
 * Every verdict is appended to the immutable audit ledger, and every held
 * spawn becomes a governance case (fail-closed: only an authorized human
 * releases it). Deterministic; fail-closed when RBAC denies RUN_AI_AGENTS.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function rbac() { return global.AAA_RBAC; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function govern() { return global.AAA_GOVERNANCE_ENGINE; }
  function template() { return global.AAA_AGENT_TEMPLATE; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

  // Hard caps a generated spec may never exceed (config-overridable downward-only in spirit).
  function maxCostCap() { return num(cfg().flag ? cfg().flag('genesisMaxCostUsd', 1.0) : 1.0, 1.0); }
  function maxRuntimeCap() { return num(cfg().flag ? cfg().flag('genesisMaxRuntimeMs', 60000) : 60000, 60000); }

  function canRunAgents() {
    const r = rbac();
    return r && r.can ? !!r.can('RUN_AI_AGENTS') : true; // absent RBAC → standalone/dev default
  }

  const Policy = {
    /**
     * Evaluate a spec for spawning. → { verdict:'allow'|'needs_approval'|'deny',
     * reasons:[], audited } . spawnedByAgent (an agent asking to spawn an agent)
     * is DENIED unless councilApproved is explicitly true.
     */
    async evaluate(spec, opts) {
      const o = opts || {};
      const reasons = [];
      let verdict = 'allow';
      const t = template();

      const v = t ? t.validate(spec) : { ok: false, issues: ['TEMPLATE_MISSING'] };
      if (!v.ok) { verdict = 'deny'; v.issues.forEach((i) => reasons.push('schema: ' + i)); }

      if (!canRunAgents()) { verdict = 'deny'; reasons.push('rbac: role lacks RUN_AI_AGENTS'); }

      if (o.spawnedByAgent && !o.councilApproved) {
        verdict = 'deny';
        reasons.push('safety: an agent may not spawn another agent without explicit Genesis Council approval');
      }

      if (verdict !== 'deny' && spec) {
        if (num(spec.maxCostUsd, 0) > maxCostCap()) { verdict = 'deny'; reasons.push('cost: maxCostUsd exceeds cap ' + maxCostCap()); }
        if (num(spec.maxRuntimeMs, 0) > maxRuntimeCap()) { verdict = 'deny'; reasons.push('cost: maxRuntimeMs exceeds cap ' + maxRuntimeCap()); }
      }

      if (verdict === 'allow' && spec && (spec.riskLevel === 'high' || spec.approvalRequired)) {
        verdict = 'needs_approval';
        reasons.push('risk: ' + spec.riskLevel + (spec.approvalRequired ? ' + approvalRequired' : ''));
      }

      // Immutable audit of the verdict itself.
      let audited = false;
      try {
        if (ledger() && ledger().append) {
          await ledger().append('genesis.spawn_policy', {
            agentId: spec ? spec.agentId : null, name: spec ? spec.name : null,
            verdict: verdict, reasons: reasons, riskLevel: spec ? spec.riskLevel : null,
            maxCostUsd: spec ? spec.maxCostUsd : null
          });
          audited = true;
        }
      } catch (_) {}

      // A held spawn becomes a governance case (fail-closed release path).
      if (verdict === 'needs_approval' && govern() && govern().record) {
        try {
          await govern().record({
            domain: 'compliance', guardrail: 'genesis_spawn_policy',
            subjectType: 'ephemeral_agent', subjectId: spec.agentId,
            decision: 'queue', verdict: 'spawn held for approval',
            categories: ['genesis', spec.riskLevel], draft: spec.name
          });
        } catch (_) {}
      }

      return { verdict: verdict, reasons: reasons, audited: audited };
    }
  };

  global.AAA_SPAWN_POLICY = Policy;
})(typeof window !== 'undefined' ? window : this);
