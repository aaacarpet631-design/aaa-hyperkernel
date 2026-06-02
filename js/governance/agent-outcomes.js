/*
 * AAA Agent Outcomes — the Agent Outcome Registry and real-world feedback loop.
 *
 * The base of the Governance Intelligence Layer: every measurable AI decision
 * (from any agent — quote, accounting, estimator, contract, SEO, ads, review,
 * scheduling, BI …) is registered here with a confidence and a recommendation,
 * then later linked to the real-world result it produced. Unsuccessful and
 * overridden decisions become training data.
 *
 * It only MEASURES — no autonomous action. Outcome attachments and the training
 * queue are written to shared memory; the attachment event is recorded in the
 * immutable governance ledger.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function events() { return global.AAA_EVENTS; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const DECISIONS = 'gov_agent_decisions';
  const TRAINING = 'gov_training_queue';

  const STATUS = ['pending', 'successful', 'unsuccessful', 'overridden', 'abandoned'];

  // Real-world results → outcome status.
  const SUCCESS_RESULTS = ['won_job', 'contract_signed', 'review_received', 'ad_conversion'];
  const FAILURE_RESULTS = ['lost_job', 'refund', 'complaint', 'chargeback'];

  // ---- pure helpers (exported for tests) ------------------------------------

  /** Normalize confidence to 0..1 (accepts 0..1 or 0..100). */
  function normConfidence(c) {
    if (c == null || isNaN(+c)) return null;
    const n = +c;
    return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
  }

  /** Map a real-world result to an outcome status (or null if unknown). */
  function resultToStatus(result) {
    if (SUCCESS_RESULTS.indexOf(result) !== -1) return 'successful';
    if (FAILURE_RESULTS.indexOf(result) !== -1) return 'unsuccessful';
    return null;
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  const Outcomes = {
    STATUS: STATUS,
    SUCCESS_RESULTS: SUCCESS_RESULTS,
    FAILURE_RESULTS: FAILURE_RESULTS,
    normConfidence: normConfidence,
    resultToStatus: resultToStatus,

    /**
     * Register an agent decision. outcomeStatus starts 'pending'.
     * @param {object} d { agentId, agentType, confidence, recommendation,
     *                      subjectType?, subjectId?, decisionId? }
     */
    async recordDecision(d) {
      if (!data() || !data().put) return { ok: false, error: 'NO_DATA' };
      d = d || {};
      if (!d.agentId || !d.agentType) return { ok: false, error: 'AGENT_REQUIRED' };
      const id = d.decisionId || ((ids() && ids().createId) ? ids().createId('adec') : ('adec_' + Date.now()));
      const rec = {
        decisionId: id, agentId: d.agentId, agentType: d.agentType,
        timestamp: now(), confidence: normConfidence(d.confidence),
        recommendation: d.recommendation != null ? d.recommendation : null,
        subjectType: d.subjectType || null, subjectId: d.subjectId || null,
        outcomeStatus: 'pending', outcome: null, override: null, humanCorrection: null,
        createdAt: now(), updatedAt: now()
      };
      await data().put(DECISIONS, id, rec);
      if (events()) events().emit('agent.decision', { decisionId: id, agentType: rec.agentType });
      return { ok: true, decision: rec };
    },

    async getDecision(id) { return (data() && data().get) ? data().get(DECISIONS, id) : null; },
    async listDecisions() { return (data() && data().list) ? data().list(DECISIONS) : []; },
    async decisionsForAgent(agentType) { return (await this.listDecisions()).filter(function (d) { return d.agentType === agentType; }); },

    /**
     * Attach a real-world result to its originating decision and update status.
     * Audited (outcome_attached). Unsuccessful/overridden decisions are queued
     * as training data. Returns { ok, decision }.
     */
    async attachOutcome(decisionId, outcome) {
      const dec = await this.getDecision(decisionId);
      if (!dec) return { ok: false, error: 'DECISION_NOT_FOUND' };
      outcome = outcome || {};
      const mapped = resultToStatus(outcome.result);
      const status = outcome.status || mapped;
      if (!status) return { ok: false, error: 'UNKNOWN_RESULT', result: outcome.result };

      const rec = Object.assign({}, dec, {
        outcomeStatus: status,
        outcome: { result: outcome.result || null, value: outcome.value != null ? +outcome.value : null, detail: outcome.detail || null, at: now() },
        humanCorrection: outcome.humanCorrection != null ? outcome.humanCorrection : dec.humanCorrection,
        updatedAt: now()
      });
      await data().put(DECISIONS, decisionId, rec);
      await audit('outcome_attached', {
        decisionId: decisionId, agentId: rec.agentId, agentType: rec.agentType,
        result: rec.outcome.result, outcomeStatus: status, value: rec.outcome.value,
        confidence: rec.confidence, at: rec.outcome.at
      });
      if (status === 'unsuccessful' || status === 'overridden') await this._queueTraining(rec);
      if (events()) events().emit('agent.outcome', { decisionId: decisionId, agentType: rec.agentType, outcomeStatus: status });
      return { ok: true, decision: rec };
    },

    /** Find decisions by subject (e.g. a job/quote id) and attach the same outcome. */
    async attachOutcomeBySubject(subjectType, subjectId, outcome) {
      const all = await this.listDecisions();
      const matches = all.filter(function (d) { return d.subjectType === subjectType && d.subjectId === subjectId && d.outcomeStatus === 'pending'; });
      const results = [];
      for (const d of matches) results.push(await this.attachOutcome(d.decisionId, outcome));
      return { ok: true, attached: results.length, results: results };
    },

    /** Mark a decision overridden (a human rejected the agent's call). Audited + queued. */
    async markOverridden(decisionId, opts) {
      const dec = await this.getDecision(decisionId);
      if (!dec) return { ok: false, error: 'DECISION_NOT_FOUND' };
      opts = opts || {};
      const rec = Object.assign({}, dec, {
        outcomeStatus: 'overridden',
        override: { reason: opts.reason || null, by: opts.actorId || null, at: now() },
        humanCorrection: opts.humanCorrection != null ? opts.humanCorrection : dec.humanCorrection,
        updatedAt: now()
      });
      await data().put(DECISIONS, decisionId, rec);
      await audit('outcome_attached', { decisionId: decisionId, agentId: rec.agentId, agentType: rec.agentType, outcomeStatus: 'overridden', overrideReason: rec.override.reason, at: rec.override.at });
      await this._queueTraining(rec);
      if (events()) events().emit('agent.outcome', { decisionId: decisionId, agentType: rec.agentType, outcomeStatus: 'overridden' });
      return { ok: true, decision: rec };
    },

    /** Mark a decision abandoned (never acted on). */
    async markAbandoned(decisionId) {
      const dec = await this.getDecision(decisionId);
      if (!dec) return { ok: false, error: 'DECISION_NOT_FOUND' };
      const rec = Object.assign({}, dec, { outcomeStatus: 'abandoned', updatedAt: now() });
      await data().put(DECISIONS, decisionId, rec);
      return { ok: true, decision: rec };
    },

    // Training queue: every unsuccessful/overridden decision becomes labeled data.
    async _queueTraining(dec) {
      const entry = {
        id: (ids() && ids().createId) ? ids().createId('train') : ('train_' + Date.now()),
        decisionId: dec.decisionId, agentId: dec.agentId, agentType: dec.agentType,
        decision: { recommendation: dec.recommendation, confidence: dec.confidence },
        outcome: dec.outcome || null,
        overrideReason: dec.override ? dec.override.reason : null,
        humanCorrection: dec.humanCorrection || null,
        finalResult: dec.outcomeStatus,
        status: 'pending_review', createdAt: now()
      };
      if (data() && data().put) await data().put(TRAINING, entry.id, entry);
      return entry;
    },

    async trainingQueue() { return (data() && data().list) ? data().list(TRAINING) : []; }
  };

  global.AAA_AGENT_OUTCOMES = Outcomes;
})(typeof window !== 'undefined' ? window : this);
