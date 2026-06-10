/*
 * AAA Governance Learning — the human-governed learning command center logic.
 *
 * Closes the loop WITHOUT autonomy: it reads the training queue, supervisor
 * recommendations, and scorecards, and lets a human review/accept/reject,
 * create improvement tasks, and export training samples. Nothing here changes a
 * prompt, price, contract, or customer-facing behavior. Every human action is
 * written to the immutable governance ledger.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function sup() { return global.AAA_GOVERNANCE_SUPERVISOR; }
  function cards() { return global.AAA_AGENT_SCORECARDS; }
  function rbac() { return global.AAA_RBAC; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const TRAINING = 'gov_training_queue';
  const RECS = 'gov_retraining_recommendations';
  const TASKS = 'gov_improvement_tasks';

  // ---- pure helpers (exported for tests) ------------------------------------

  // Severity of a training case from its final result (for filtering/sorting).
  function severityOf(entry) {
    const r = (entry.outcome && entry.outcome.result) || entry.finalResult;
    if (r === 'chargeback' || r === 'refund' || r === 'complaint') return 'high';
    if (entry.finalResult === 'unsuccessful' || entry.finalResult === 'overridden') return 'medium';
    return 'low'; // abandoned, other
  }

  // Apply UI filters to training cases. Pure.
  function filterCases(cases, f) {
    f = f || {};
    return (cases || []).filter(function (c) {
      if (f.agentType && c.agentType !== f.agentType) return false;
      if (f.status && c.status !== f.status) return false;
      if (f.severity && severityOf(c) !== f.severity) return false;
      if (f.outcomeType) {
        const res = (c.outcome && c.outcome.result) || null;
        if (res !== f.outcomeType && c.finalResult !== f.outcomeType) return false;
      }
      if (f.since != null && (c.createdAt || 0) < f.since) return false;
      if (f.until != null && (c.createdAt || 0) > f.until) return false;
      return true;
    });
  }

  // Redact obvious PII from free text (emails, phone numbers).
  function scrubPII(s) {
    if (s == null) return s;
    return String(s)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[phone]');
  }

  // Allowlisted, PII-scrubbed training sample for export. Customer fields are
  // never carried; free-text is redacted.
  function toSample(entry) {
    const dec = entry.decision || {};
    return {
      decisionId: entry.decisionId || null,
      agentId: entry.agentId || null,
      agentType: entry.agentType || null,
      confidence: dec.confidence != null ? dec.confidence : null,
      recommendation: scrubPII(dec.recommendation),
      outcomeResult: entry.outcome ? entry.outcome.result : null,
      finalResult: entry.finalResult || null,
      overrideReason: scrubPII(entry.overrideReason),
      humanCorrection: scrubPII(entry.humanCorrection),
      date: entry.createdAt || null
    };
  }

  function toJSONL(samples) { return (samples || []).map(function (s) { return JSON.stringify(s); }).join('\n'); }

  function priorityFromSeverity(sev) { return ({ critical: 'urgent', high: 'high', medium: 'medium', low: 'low' })[sev] || 'medium'; }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  function actor(opts) {
    opts = opts || {};
    const uid = cfg().firebaseUid || (cfg().flag ? cfg().flag('firebaseUid', null) : null);
    return { id: opts.actorId || uid || 'local-operator', role: (rbac() && rbac().role) ? rbac().role() : 'unknown' };
  }

  const Learning = {
    // pure
    severityOf: severityOf, filterCases: filterCases, scrubPII: scrubPII, toSample: toSample, toJSONL: toJSONL,

    // ---- training queue ----------------------------------------------------
    /** Training cases (optionally filtered): unsuccessful/overridden/abandoned/refund/… */
    async trainingCases(filter) {
      const all = (data() && data().list) ? await data().list(TRAINING) : [];
      return filterCases(all, filter).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    },

    // ---- supervisor recommendations (recommendation-only) ------------------
    /** Run the supervisor over agents that have scorecards. Recommendation-only. */
    async recommendations(agentType) {
      if (!sup() || !cards()) return [];
      const types = agentType ? [agentType] : (await cards().list()).map(function (c) { return c.agentType; });
      let out = [];
      for (const tpe of types) {
        const r = await sup().review(tpe);
        if (r && r.ok && Array.isArray(r.stored)) out = out.concat(r.stored);
      }
      return out;
    },

    async openRecommendations() { return ((data() && data().list) ? await data().list(RECS) : []).filter(function (r) { return r.status === 'proposed'; }); },

    // ---- human action workflow (all audited) -------------------------------
    /** Mark a training case reviewed. */
    async markReviewed(trainingId, opts) {
      const entry = (data() && data().get) ? await data().get(TRAINING, trainingId) : null;
      if (!entry) return { ok: false, error: 'NOT_FOUND' };
      const who = actor(opts);
      const upd = Object.assign({}, entry, { status: 'reviewed', reviewedBy: who.id, reviewedAt: now() });
      await data().put(TRAINING, trainingId, upd);
      await audit('training_reviewed', { trainingId: trainingId, agentType: entry.agentType, decisionId: entry.decisionId, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, case: upd };
    },

    /** Accept a recommendation → creates an improvement task. Audited. No code change. */
    async acceptRecommendation(recId, opts) {
      opts = opts || {};
      const rec = (data() && data().get) ? await data().get(RECS, recId) : null;
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const who = actor(opts);
      const upd = Object.assign({}, rec, { status: 'accepted', decidedBy: who.id, decidedAt: now() });
      await data().put(RECS, recId, upd);
      await audit('recommendation_accepted', { recId: recId, agentType: rec.agentType, type: rec.type, actorId: who.id, actorRole: who.role, at: now() });
      const task = await this.createImprovementTask({
        agentId: rec.agentType, issue: rec.issue || rec.reason, recommendedChange: rec.suggestedAction,
        priority: priorityFromSeverity(rec.severity), owner: opts.owner || null,
        sourceTrainingCases: opts.sourceTrainingCases || [], recId: recId
      }, opts);
      return { ok: true, recommendation: upd, task: task.task };
    },

    /** Reject a recommendation. Audited. */
    async rejectRecommendation(recId, opts) {
      opts = opts || {};
      const rec = (data() && data().get) ? await data().get(RECS, recId) : null;
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const who = actor(opts);
      const upd = Object.assign({}, rec, { status: 'rejected', decidedBy: who.id, decidedAt: now(), rejectReason: opts.reason || null });
      await data().put(RECS, recId, upd);
      await audit('recommendation_rejected', { recId: recId, agentType: rec.agentType, type: rec.type, reason: opts.reason || null, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, recommendation: upd };
    },

    // ---- improvement task ledger -------------------------------------------
    /** Create an improvement task (open). Audited. Never edits code/prompts. */
    async createImprovementTask(input, opts) {
      input = input || {};
      const who = actor(opts);
      const task = {
        taskId: (global.AAA_ID_FACTORY && global.AAA_ID_FACTORY.createId) ? global.AAA_ID_FACTORY.createId('task') : ('task_' + Date.now()),
        agentId: input.agentId || null, issue: input.issue || null, recommendedChange: input.recommendedChange || null,
        priority: input.priority || 'medium', owner: input.owner || null, status: 'open',
        sourceTrainingCases: Array.isArray(input.sourceTrainingCases) ? input.sourceTrainingCases : [],
        recId: input.recId || null, createdBy: who.id, createdAt: now(), updatedAt: now()
      };
      if (data() && data().put) await data().put(TASKS, task.taskId, task);
      await audit('improvement_task_created', { taskId: task.taskId, agentId: task.agentId, priority: task.priority, owner: task.owner, recId: task.recId, sourceTrainingCases: task.sourceTrainingCases, actorId: who.id, actorRole: who.role, at: task.createdAt });
      return { ok: true, task: task };
    },

    /** Update a task's status (open/in_progress/implemented/rejected). Audited. */
    async updateTaskStatus(taskId, status, opts) {
      const allowed = ['open', 'in_progress', 'implemented', 'rejected'];
      if (allowed.indexOf(status) === -1) return { ok: false, error: 'BAD_STATUS' };
      const task = (data() && data().get) ? await data().get(TASKS, taskId) : null;
      if (!task) return { ok: false, error: 'NOT_FOUND' };
      const who = actor(opts);
      const upd = Object.assign({}, task, { status: status, updatedAt: now() });
      await data().put(TASKS, taskId, upd);
      await audit('task_status_changed', { taskId: taskId, status: status, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, task: upd };
    },

    async tasks() { return (data() && data().list) ? data().list(TASKS) : []; },

    // ---- export ------------------------------------------------------------
    /**
     * Export training samples as PII-stripped JSONL. Pass an array of training
     * ids, or a filter. Audited (ids + count only — never PII). Returns
     * { ok, jsonl, count, ids }.
     */
    async exportTrainingSamples(idsOrFilter, opts) {
      opts = opts || {};
      let entries;
      if (Array.isArray(idsOrFilter)) {
        entries = [];
        for (const id of idsOrFilter) { const e = await data().get(TRAINING, id); if (e) entries.push(e); }
      } else {
        entries = await this.trainingCases(idsOrFilter || {});
      }
      const samples = entries.map(toSample);
      const jsonl = toJSONL(samples);
      const ids = entries.map(function (e) { return e.id; });
      const who = actor(opts);
      await audit('training_exported', { count: samples.length, ids: ids, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, jsonl: jsonl, count: samples.length, ids: ids };
    }
  };

  global.AAA_GOVERNANCE_LEARNING = Learning;
})(typeof window !== 'undefined' ? window : this);
