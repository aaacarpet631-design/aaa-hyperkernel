/*
 * AAA Global Desk — international dispatch for the agent organization.
 *
 * One seam through which market-scoped work reaches the AI team. The desk:
 *   1. resolves the target market's country pack (unknown market → honest
 *      refusal, never a silent US default),
 *   2. injects the market context (currency, tax regime, units, privacy
 *      regime, language) into the agent's context so a Berlin quote is
 *      reasoned about in EUR + USt + m², not Texas assumptions,
 *   3. routes by department (sales/operations/finance/…) to the registered
 *      agent persona via AAA_AGENT_OS (which logs + gates as always),
 *   4. seals the result in a Decision Envelope — so EVERY dispatched decision
 *      carries confidence, localized impact, gate verdict, approval state,
 *      rollback plan, and an audit-chained record. No envelope, no dispatch.
 *
 * Strictly a router/composer: it never mutates business data and never calls
 * a model directly. Honest by construction — with no orchestrator or proxy it
 * returns { ok:false, error }, never fabricated decisions.
 */
;(function (global) {
  'use strict';

  function os() { return global.AAA_AGENT_OS; }
  function packs() { return global.AAA_COUNTRY_PACKS; }
  function envelope() { return global.AAA_DECISION_ENVELOPE; }
  function registry() { return global.AAA_AGENTS; }

  // Department → registered agent persona. Extend at runtime via setRoute()
  // (new departments are a registry entry, not code surgery).
  const ROUTES = {
    sales: 'sales',
    operations: 'operations',
    marketing: 'marketing',
    finance: 'accounting',
    customer: 'customer_success',
    compliance: 'compliance',
    analytics: 'data_scientist',
    kpi: 'kpi',
    executive: 'ceo'
  };

  const GlobalDesk = {
    /** The department routing table (live copy). */
    departments: function () { return Object.keys(ROUTES).sort(); },
    routeFor: function (department) { return ROUTES[String(department || '').toLowerCase()] || null; },

    /** Point a department at a different (e.g. custom) agent persona. */
    setRoute: function (department, agentId) {
      if (!department || !agentId) return { ok: false, error: 'BAD_ROUTE' };
      if (registry() && !registry().get(agentId)) return { ok: false, error: 'UNKNOWN_AGENT', agentId: agentId };
      ROUTES[String(department).toLowerCase()] = agentId;
      return { ok: true, department: String(department).toLowerCase(), agentId: agentId };
    },

    /**
     * Dispatch one task to the AI team for a specific market.
     *
     * opts: { country, department | agent, context, impact:{amount,description},
     *         evidence:[], rollback:{plan,reversible}, taskKind }
     * @returns { ok, agent, market, decision, envelope } | { ok:false, error }
     */
    dispatch: async function (task, opts) {
      const o = opts || {};
      if (!task) return { ok: false, error: 'NO_TASK' };
      const orchestrator = os();
      if (!orchestrator || !orchestrator.runAgent) return { ok: false, error: 'AGENT_OS_MISSING' };
      const env = envelope();
      if (!env) return { ok: false, error: 'ENVELOPE_MISSING', reason: 'ungoverned dispatch is not allowed' };
      const cp = packs();
      if (!cp) return { ok: false, error: 'COUNTRY_PACKS_MISSING' };

      // 1. resolve the market — explicitly, never a silent fallback.
      const market = o.country != null ? cp.contextFor(o.country) : cp.contextFor(null);
      if (!market) return { ok: false, error: 'UNKNOWN_COUNTRY', country: o.country };

      // 1b. restricted-market check (fail-closed): a tenant policy that
      // restricts this market stops the dispatch before any agent runs.
      const tenantPolicy = global.AAA_TENANT_MODEL_POLICY;
      if (tenantPolicy && tenantPolicy.marketAllowed) {
        const mk = await tenantPolicy.marketAllowed(market.country);
        if (!mk.ok) return { ok: false, error: 'MARKET_RESTRICTED', denial: mk.denial, market: market.country };
      }

      // 2. resolve the agent.
      const agentId = o.agent || this.routeFor(o.department);
      if (!agentId) return { ok: false, error: 'UNKNOWN_DEPARTMENT', department: o.department || null };

      // 3. run through the governed orchestrator with the market injected.
      const context = Object.assign({}, o.context || {}, { market: market });
      const run = await orchestrator.runAgent(agentId, task, context, { taskKind: o.taskKind });
      if (!run || run.ok === false) {
        return { ok: false, error: (run && run.error) || 'RUN_FAILED', agent: agentId, market: market.country };
      }

      // 4. seal the decision in an envelope — the non-negotiable contract.
      const evidence = (Array.isArray(o.evidence) ? o.evidence.slice() : []);
      if (run.decisionId) evidence.push({ type: 'agent_decision', id: run.decisionId, note: 'orchestrator decision log' });
      const wrapped = env.wrap({
        agent: agentId,
        decision: {
          recommendation: run.recommendation, rationale: run.rationale,
          confidence: run.confidence, risks: run.risks, next_actions: run.next_actions
        },
        impact: o.impact,
        evidence: evidence,
        rollback: o.rollback,
        context: context,
        country: market.country
      });
      if (!wrapped.ok) return { ok: false, error: 'ENVELOPE_REJECTED', issues: wrapped.issues, agent: agentId };
      const sealed = await env.seal(wrapped.envelope);
      if (!sealed.ok) return { ok: false, error: sealed.error, issues: sealed.issues, agent: agentId };

      return {
        ok: true, agent: agentId, market: market.country,
        decision: wrapped.envelope.decision,
        approval: sealed.envelope.approval,
        envelope: sealed.envelope
      };
    },

    /** Dispatch the same task across several markets (e.g. a pricing review per country). */
    dispatchAcrossMarkets: async function (task, countries, opts) {
      const list = Array.isArray(countries) ? countries : [];
      if (!list.length) return { ok: false, error: 'NO_COUNTRIES' };
      const results = [];
      for (const c of list) {
        results.push(await this.dispatch(task, Object.assign({}, opts || {}, { country: c })));
      }
      return {
        ok: results.every(function (r) { return r.ok; }),
        results: results,
        awaitingApproval: results.filter(function (r) { return r.ok && r.approval && r.approval.status === 'awaiting_approval'; }).length
      };
    }
  };

  global.AAA_GLOBAL_DESK = GlobalDesk;
})(typeof window !== 'undefined' ? window : this);
