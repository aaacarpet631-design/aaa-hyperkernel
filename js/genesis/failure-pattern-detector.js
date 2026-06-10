/*
 * AAA Failure Pattern Detector — the immune system of the Capability Economy.
 *
 * Scans the immutable ledger, tool requests/invocations, and the audit trail
 * for the seven demotion/ban signatures and recommends an action:
 *
 *   hallucinated_tool_requests   INVALID_TOOL_DNA / repeated held-then-unused
 *   invalid_graph_writes         OUTPUT_SCHEMA_INVALID runs / unbound writes
 *   high_cost_recursion          cost or latency budget blowouts, repeated
 *   repeated_human_rejection     rejected promotion proposals / held releases denied
 *   unsafe_customer_facing       governance cases on customer-facing drafts
 *   failed_rollback              a rollback that could not retract its facts
 *   policy_violation             spawn-policy denials attributed to this DNA
 *
 * Each pattern carries a severity and a recommendation
 * ('quarantine' | 'ban' | 'watch'); the banned-capability registry consumes
 * these. Pure and read-only — it judges, it never executes. Thresholds are
 * config-overridable; honest by construction (no signal → no pattern).
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_CAPABILITY_LEDGER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }

  function pattern(kind, count, severity, recommendation, detail) {
    return { kind: kind, count: count, severity: severity, recommendation: recommendation, detail: detail || null };
  }

  const Detector = {
    /**
     * Scan one capability signature. Returns
     * { signature, patterns:[], violations, openViolations, recommendation }.
     * recommendation is the strongest across patterns: ban > quarantine > watch > none.
     */
    async scan(signature) {
      const entries = await ledger().entries({ signature: signature });
      const runIds = {}; entries.forEach((e) => { runIds[e.runId] = true; });
      const names = {}; entries.forEach((e) => { if (e.agentSpec) names[e.agentSpec.name] = true; });
      const patterns = [];

      // invalid graph writes — schema-invalid output runs
      const invalidWrites = entries.filter((e) => e.executionResult === 'failed' && /OUTPUT_SCHEMA_INVALID|READ_DENIED|NOT_YOUR_FACT/.test(e.error || '')).length;
      if (invalidWrites >= flag('capInvalidWriteBan', 3)) patterns.push(pattern('invalid_graph_writes', invalidWrites, 'high', 'ban'));
      else if (invalidWrites >= 1) patterns.push(pattern('invalid_graph_writes', invalidWrites, 'medium', 'quarantine'));

      // high-cost recursion — budget blowouts
      const blowouts = entries.filter((e) => /COST_BUDGET_EXCEEDED|RUNTIME_BUDGET_EXCEEDED/.test(e.error || '')).length;
      if (blowouts >= flag('capBlowoutBan', 3)) patterns.push(pattern('high_cost_recursion', blowouts, 'high', 'ban'));
      else if (blowouts >= 1) patterns.push(pattern('high_cost_recursion', blowouts, 'medium', 'quarantine'));

      // failed rollback
      const failedRollback = entries.filter((e) => /ROLLBACK_FAILED/.test(e.error || '')).length;
      if (failedRollback >= 1) patterns.push(pattern('failed_rollback', failedRollback, 'high', 'ban'));

      // hallucinated tool requests — invalid DNA or held-and-abandoned
      let halluc = 0;
      try {
        const reqs = (await data().list('tool_requests')).filter(mine).filter((r) => names[r.spec && r.spec.name] || runIds[r.runId]);
        halluc = reqs.filter((r) => r.status === 'held' || r.status === 'rejected').length;
      } catch (_) {}
      try {
        const invs = (await data().list('tool_invocations')).filter(mine).filter((i) => runIds[i.runId]);
        halluc += invs.filter((i) => i.error === 'TOOL_TARGET_UNBOUND' || i.error === 'INVALID_ARGS').length;
      } catch (_) {}
      if (halluc >= flag('capHallucBan', 5)) patterns.push(pattern('hallucinated_tool_requests', halluc, 'high', 'ban'));
      else if (halluc >= flag('capHallucWatch', 2)) patterns.push(pattern('hallucinated_tool_requests', halluc, 'medium', 'quarantine'));

      // repeated human rejection — rejected promotion proposals for this name
      let rejections = 0;
      try { rejections = (await data().list('promotion_proposals')).filter(mine).filter((p) => names[p.name] && p.status === 'rejected').length; } catch (_) {}
      if (rejections >= flag('capRejectionBan', 3)) patterns.push(pattern('repeated_human_rejection', rejections, 'high', 'ban'));
      else if (rejections >= 1) patterns.push(pattern('repeated_human_rejection', rejections, 'medium', 'quarantine'));

      // unsafe customer-facing drafts / policy violations — governance audit
      let unsafe = 0, policy = 0;
      try {
        const audit = (await data().list('governance_audit')).filter(mine);
        unsafe = audit.filter((a) => a.payload && names[a.payload.name] && /content_safety|customer/.test(JSON.stringify(a.payload))).length;
        policy = audit.filter((a) => a.type === 'genesis.spawn_policy' && a.payload && names[a.payload.name] && a.payload.verdict === 'deny').length;
      } catch (_) {}
      if (unsafe >= 1) patterns.push(pattern('unsafe_customer_facing', unsafe, 'high', 'ban'));
      if (policy >= flag('capPolicyBan', 3)) patterns.push(pattern('policy_violation', policy, 'high', 'ban'));
      else if (policy >= 1) patterns.push(pattern('policy_violation', policy, 'medium', 'quarantine'));

      const rank = { ban: 3, quarantine: 2, watch: 1 };
      let rec = 'none', best = 0;
      patterns.forEach((p) => { const r = rank[p.recommendation] || 0; if (r > best) { best = r; rec = p.recommendation; } });
      const violations = patterns.reduce((a, p) => a + p.count, 0);

      return { signature: signature, patterns: patterns, violations: violations, openViolations: violations, recommendation: rec };
    },

    /** Scan every signature; return only those with a recommendation. */
    async scanAll() {
      const sigs = await ledger().signatures();
      const out = [];
      for (const s of sigs) { const r = await this.scan(s.signature); if (r.recommendation !== 'none') out.push(Object.assign({ dna: s.dna, name: s.name }, r)); }
      return out;
    }
  };

  global.AAA_FAILURE_DETECTOR = Detector;
})(typeof window !== 'undefined' ? window : this);
