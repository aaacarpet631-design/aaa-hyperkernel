/*
 * AAA Governance Engine — the enterprise governance layer for high-risk AI
 * decisions. Content-safety on review requests is its FIRST consumer, but it is
 * built generic: any guardrail (legal, accounting, contract, compliance, review
 * generation, ad copy, SMS, email …) records its decisions here and inherits the
 * same review → override → audit → training → analytics pipeline.
 *
 * Pipeline:
 *   record()          a guardrail's verdict becomes a governance CASE
 *   requestOverride() an Admin (owner) unlocks a blocked/queued case, with a
 *                     mandatory written justification — every step written to
 *                     the immutable audit ledger and copied to the supervisor
 *                     review queue (training data). NEVER sends.
 *   recordSent()      a human's explicit Send is its own audited event.
 *   metrics()         dashboard counters across every domain.
 *
 * Design rules:
 *   - Fail-closed: only an explicit Admin override unlocks a held decision.
 *   - The override gate uses RBAC authority (can('OVERRIDE_AI_DECISION')),
 *     not a client-supplied role, so it can't be spoofed.
 *   - Cases are mutable state; the AUDIT LEDGER is the immutable record.
 *   - Repeated overrides of the same category raise a drift alert.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cloud() { return global.AAA_CLOUD; }
  function rbac() { return global.AAA_RBAC; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function events() { return global.AAA_EVENTS; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const CASES = 'governance_cases';
  const QUEUE = 'governance_review_queue';   // supervisor review / training data
  const ALERTS = 'governance_alerts';

  // Minimum characters for an override justification — no blank/token reasons.
  const MIN_REASON = 20;
  // Repeated overrides of one category before a drift alert is raised.
  const PATTERN_THRESHOLD = 3;

  // Future-proof domain registry. New guardrails register their domain here so
  // dashboards and the supervisor can reason about them uniformly.
  const DOMAINS = {
    content_safety: 'Content safety (customer-facing text)',
    review_generation: 'AI-generated review requests',
    legal: 'Legal language / disclaimers',
    accounting: 'Accounting & financial postings',
    contract: 'Contract terms & signatures',
    compliance: 'Regulatory compliance',
    ad_copy: 'Advertising / marketing copy',
    sms: 'Outbound SMS',
    email: 'Outbound email'
  };

  // Override is only meaningful for a held decision.
  function isHeld(decision) { return decision === 'block' || decision === 'queue'; }

  // ---- pure helpers (exported for tests) ------------------------------------

  /** Validate an override request. Returns { ok } or { ok:false, error }. */
  function validateOverride(canOverride, reason) {
    if (!canOverride) return { ok: false, error: 'FORBIDDEN' };
    const r = String(reason == null ? '' : reason).trim();
    if (r.length < MIN_REASON) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: MIN_REASON };
    return { ok: true, reason: r };
  }

  /** Dashboard counters computed from the case set. */
  function computeMetrics(cases) {
    const list = Array.isArray(cases) ? cases : [];
    let checks = 0, blocked = 0, queued = 0, overrides = 0, fpCandidates = 0, allowed = 0, upheld = 0;
    list.forEach(function (c) {
      checks++;
      if (c.decision === 'block') blocked++;
      else if (c.decision === 'queue') queued++;
      else if (c.decision === 'allow') allowed++;
      // An override is counted whenever one was recorded, even if the case has
      // since moved on (e.g. to 'sent') — the override still happened.
      if (c.status === 'overridden' || c.override) {
        overrides++;
        // A blocked decision a human overrode is a candidate false positive
        // (the classifier said "unsafe"; a human judged it fine).
        if (c.decision === 'block') fpCandidates++;
      }
      if (c.status === 'upheld') upheld++;
    });
    const held = blocked + queued;
    return {
      safetyChecks: checks,
      blocked: blocked,
      queued: queued,
      allowed: allowed,
      overrides: overrides,
      upheld: upheld,
      overrideRate: held ? overrides / held : 0,
      falsePositiveCandidates: fpCandidates
    };
  }

  /** Count overrides per category across the review queue. */
  function categoryCounts(queueEntries) {
    const counts = {};
    (Array.isArray(queueEntries) ? queueEntries : []).forEach(function (q) {
      (Array.isArray(q.categories) ? q.categories : []).forEach(function (cat) {
        counts[cat] = (counts[cat] || 0) + 1;
      });
    });
    return counts;
  }

  // ---- internal ops ---------------------------------------------------------

  function actor(partial) {
    partial = partial || {};
    const uid = cfg().firebaseUid || (cfg().flag ? cfg().flag('firebaseUid', null) : null);
    return {
      id: partial.actorId || uid || cfg().workspaceId || 'local-operator',
      // Authoritative role comes from RBAC, not the caller.
      role: (rbac() && rbac().role) ? rbac().role() : (partial.actorRole || 'unknown')
    };
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  async function detectPatterns(category) {
    if (!category) return null;
    const q = (data() && data().list) ? await data().list(QUEUE) : [];
    const count = categoryCounts(q)[category] || 0;
    if (count < PATTERN_THRESHOLD) return null;
    const alert = {
      id: 'galert_' + String(category).replace(/[^a-z0-9]+/gi, '_').toLowerCase(),
      kind: 'override_pattern',
      category: category,
      count: count,
      message: 'Category "' + category + '" overridden ' + count + ' times — possible model drift or an overly aggressive classifier.',
      status: 'open',
      raisedAt: now(), at: nowISO()
    };
    if (data() && data().put) await data().put(ALERTS, alert.id, alert);
    if (events()) events().emit('governance.alert', alert);
    return alert;
  }

  const Governance = {
    DOMAINS: DOMAINS,
    MIN_REASON: MIN_REASON,
    PATTERN_THRESHOLD: PATTERN_THRESHOLD,
    // pure helpers
    validateOverride: validateOverride,
    computeMetrics: computeMetrics,
    categoryCounts: categoryCounts,

    /** True if the current actor may override a held decision. */
    canOverride() { return !!(rbac() && rbac().can && rbac().can('OVERRIDE_AI_DECISION')); },

    /**
     * Record a guardrail decision as a governance case. Idempotent per
     * (domain, subjectId). Held decisions (block/queue) are 'open' (overridable);
     * allow decisions are terminal. Flagged decisions are written to the ledger.
     * Returns { ok, case }.
     */
    async record(input) {
      if (!data() || !data().put) return { ok: false, error: 'NO_DATA' };
      input = input || {};
      const decision = input.decision || 'allow';
      const existing = await this.caseForSubject(input.domain, input.subjectId);
      const id = existing ? existing.id : ((ids() && ids().createId) ? ids().createId('gov') : ('gov_' + Date.now()));
      const rec = Object.assign({}, existing, {
        id: id,
        domain: input.domain || 'content_safety',
        guardrail: input.guardrail || null,
        model: input.model || null,
        subjectType: input.subjectType || null,
        subjectId: input.subjectId || null,
        messageContextId: input.messageContextId || input.subjectId || null,
        decision: decision,
        // Preserve prior values on idempotent re-record when the new input omits them.
        verdict: input.verdict != null ? input.verdict : (existing && existing.verdict) || null,
        categories: Array.isArray(input.categories) ? input.categories : ((existing && existing.categories) || []),
        raw: input.raw != null ? input.raw : (existing && existing.raw) || null,
        draft: input.draft != null ? input.draft : (existing && existing.draft) || null,
        status: isHeld(decision) ? 'open' : 'allowed',
        createdAt: existing ? existing.createdAt : now(),
        updatedAt: now()
      });
      await data().put(CASES, id, rec);
      if (isHeld(decision)) {
        await audit('flagged', {
          caseId: id, domain: rec.domain, guardrail: rec.guardrail, model: rec.model,
          decision: decision, verdict: rec.verdict, categories: rec.categories,
          messageContextId: rec.messageContextId
        });
      }
      return { ok: true, case: rec };
    },

    async getCase(id) { return (data() && data().get) ? data().get(CASES, id) : null; },

    async caseForSubject(domain, subjectId) {
      if (!subjectId || !data() || !data().list) return null;
      const list = await data().list(CASES);
      return (list || []).find(function (c) { return c.subjectId === subjectId && c.domain === domain; }) || null;
    },

    /**
     * Admin override of a held case. Enforces the RBAC gate + mandatory
     * justification, writes an immutable audit trail, copies the decision into
     * the supervisor review queue (training data), runs drift detection, and
     * marks the case overridden + unlocked. It NEVER sends — it only unlocks the
     * Send button for an explicit human action (see recordSent).
     * Returns { ok, case, unlocked:true } or { ok:false, error }.
     */
    async requestOverride(caseId, opts) {
      opts = opts || {};
      const c = await this.getCase(caseId);
      if (!c) return { ok: false, error: 'CASE_NOT_FOUND' };
      if (!isHeld(c.decision)) return { ok: false, error: 'NOT_OVERRIDABLE' };
      if (c.status === 'overridden') return { ok: true, case: c, unlocked: true, already: true };

      const who = actor(opts);
      const can = this.canOverride();
      const v = validateOverride(can, opts.reason);
      if (!v.ok) {
        // Audit the refused attempt too — denials are part of the record.
        await audit(can ? 'override_denied' : 'override_forbidden', {
          caseId: caseId, actorId: who.id, actorRole: who.role,
          messageContextId: c.messageContextId, verdict: c.verdict, categories: c.categories,
          reason: String(opts.reason || ''), error: v.error
        });
        return { ok: false, error: v.error, minChars: v.minChars };
      }

      const at = nowISO();
      const auditPayload = {
        caseId: caseId, domain: c.domain, guardrail: c.guardrail, model: c.model,
        actorId: who.id, actorRole: who.role,
        originalVerdict: c.verdict, originalDecision: c.decision,
        categories: c.categories, messageContextId: c.messageContextId,
        reason: v.reason, finalAction: 'override_unlock_send'
      };
      await audit('override_requested', auditPayload);
      const approved = await audit('override_approved', auditPayload);

      const override = {
        actorId: who.id, actorRole: who.role, reason: v.reason,
        at: now(), atISO: at, auditId: approved ? approved.id : null,
        finalAction: 'override_unlock_send'
      };
      const updated = Object.assign({}, c, { status: 'overridden', unlocked: true, override: override, updatedAt: now() });
      await data().put(CASES, caseId, updated);

      // Supervisor review queue — every override becomes labeled training data
      // (model said X, an Admin overrode with reason Y).
      const queueEntry = {
        id: (ids() && ids().createId) ? ids().createId('gq') : ('gq_' + Date.now()),
        caseId: caseId, domain: c.domain, guardrail: c.guardrail, model: c.model,
        subjectType: c.subjectType, subjectId: c.subjectId, messageContextId: c.messageContextId,
        decision: c.decision, verdict: c.verdict, categories: c.categories, raw: c.raw, draft: c.draft,
        overrideReason: v.reason, actorId: who.id, actorRole: who.role,
        status: 'pending_review', createdAt: now(), at: at
      };
      await data().put(QUEUE, queueEntry.id, queueEntry);

      // Drift detection across the queue's categories.
      let alert = null;
      for (const cat of (Array.isArray(c.categories) ? c.categories : [])) {
        const a = await detectPatterns(cat);
        if (a) alert = a;
      }
      if (events()) events().emit('governance.override', { caseId: caseId, domain: c.domain, actorId: who.id });

      return { ok: true, case: updated, unlocked: true, queued: queueEntry.id, alert: alert };
    },

    /**
     * Record that a human explicitly sent the message (after an override, or a
     * normal allowed send). Separate, audited action — overriding never sends.
     */
    async recordSent(caseId, opts) {
      opts = opts || {};
      const c = await this.getCase(caseId);
      if (!c) return { ok: false, error: 'CASE_NOT_FOUND' };
      const who = actor(opts);
      await audit('sent', {
        caseId: caseId, domain: c.domain, actorId: who.id, actorRole: who.role,
        messageContextId: c.messageContextId, channel: opts.channel || null,
        viaOverride: c.status === 'overridden'
      });
      const updated = Object.assign({}, c, { status: 'sent', sentAt: now(), updatedAt: now() });
      await data().put(CASES, caseId, updated);
      return { ok: true, case: updated };
    },

    /** Admin agrees with the guardrail and keeps the block (also audited). */
    async uphold(caseId, opts) {
      opts = opts || {};
      const c = await this.getCase(caseId);
      if (!c) return { ok: false, error: 'CASE_NOT_FOUND' };
      const who = actor(opts);
      await audit('upheld', { caseId: caseId, domain: c.domain, actorId: who.id, actorRole: who.role, reason: String(opts.reason || ''), messageContextId: c.messageContextId });
      const updated = Object.assign({}, c, { status: 'upheld', updatedAt: now() });
      await data().put(CASES, caseId, updated);
      return { ok: true, case: updated };
    },

    async listCases() { return (data() && data().list) ? data().list(CASES) : []; },
    async reviewQueue() { return (data() && data().list) ? data().list(QUEUE) : []; },
    async alerts() { return (data() && data().list) ? data().list(ALERTS) : []; },

    /** Dashboard counters across every governed domain. */
    async metrics() {
      const cases = await this.listCases();
      const m = computeMetrics(cases);
      const openAlerts = (await this.alerts()).filter(function (a) { return a.status !== 'resolved'; });
      m.alerts = openAlerts.length;
      m.reviewQueue = (await this.reviewQueue()).filter(function (q) { return q.status === 'pending_review'; }).length;
      return m;
    }
  };

  global.AAA_GOVERNANCE = Governance;
})(typeof window !== 'undefined' ? window : this);
