/*
 * AAA Governance Bridge — automatic measurement integration.
 *
 * The seam that makes governance active without coupling it to every agent or
 * UI. Two directions:
 *   measure(agentType, opts) — agents record a decision (idempotent, audited).
 *   business events           — real outcomes auto-attach to pending decisions.
 *
 * It is pure instrumentation: it never changes pricing, contracts, sends, or any
 * customer-facing behavior, and every call is wrapped so a failure can never
 * break the originating flow. It bridges the app's existing events
 * (outcome.recorded, contract.signed) to the Agent Outcome Registry.
 */
;(function (global) {
  'use strict';

  function reg() { return global.AAA_AGENT_OUTCOMES; }
  function events() { return global.AAA_EVENTS; }

  // Map the app's outcome vocabulary → the registry's real-world result names.
  const RESULT_MAP = {
    won: 'won_job', won_job: 'won_job',
    lost: 'lost_job', lost_job: 'lost_job',
    review: 'review_received', review_received: 'review_received',
    refund: 'refund', complaint: 'complaint', chargeback: 'chargeback',
    contract_signed: 'contract_signed', quote_accepted: 'won_job', quote_rejected: 'lost_job',
    payment_completed: 'won_job', ad_conversion: 'ad_conversion', ad_lead_converted: 'ad_conversion'
  };

  // Which agent types a given real result validates (null = all pending on the job).
  const RESULT_AGENTS = {
    won_job: ['estimator', 'quote'], lost_job: ['estimator', 'quote'],
    review_received: ['review_request'],
    contract_signed: ['contract', 'quote', 'estimator'],
    ad_conversion: ['ads', 'seo'],
    refund: ['estimator', 'quote'], complaint: ['estimator', 'quote'], chargeback: ['estimator', 'quote']
  };

  const Bridge = {
    RESULT_MAP: RESULT_MAP,
    RESULT_AGENTS: RESULT_AGENTS,

    /** Record an agent decision (idempotent, audited). Never throws. */
    async measure(agentType, opts) {
      try {
        if (!reg() || !reg().recordDecision) return { ok: false, error: 'NO_REGISTRY' };
        opts = opts || {};
        return await reg().recordDecision(Object.assign({ agentType: agentType, agentId: opts.agentId || agentType }, opts));
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },

    /**
     * Attach a real-world outcome to the pending decisions it validates.
     * Routes by jobId (preferred) or subject. Backfill-safe + never throws.
     */
    async attach(result, opts) {
      try {
        if (!reg() || !reg().attachOutcomeByJob) return { ok: false, error: 'NO_REGISTRY' };
        opts = opts || {};
        const mapped = RESULT_MAP[result] || result;
        const outcome = { result: mapped, value: opts.value != null ? opts.value : null, detail: opts.detail || null };
        const agentTypes = opts.agentTypes || RESULT_AGENTS[mapped] || null;
        if (opts.jobId) return await reg().attachOutcomeByJob(opts.jobId, outcome, { agentTypes: agentTypes });
        if (opts.subjectId) return await reg().attachOutcomeBySubject(opts.subjectType || null, opts.subjectId, outcome);
        return { ok: true, attached: 0 };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },

    // ---- event wiring -------------------------------------------------------
    init() {
      if (this._wired || !events() || !events().on) return this;
      const self = this;
      events().on('outcome.recorded', function (rec) {
        if (!rec) return;
        self.attach(rec.result, { jobId: rec.jobId, value: rec.value != null ? rec.value : rec.amount });
      });
      events().on('contract.signed', function (rec) {
        if (!rec) return;
        self.attach('contract_signed', { jobId: rec.jobId, subjectType: 'contract', subjectId: rec.contractId, value: rec.total });
      });
      this._wired = true;
      return this;
    }
  };

  Bridge.init();
  global.AAA_GOVERNANCE_BRIDGE = Bridge;
})(typeof window !== 'undefined' ? window : this);
