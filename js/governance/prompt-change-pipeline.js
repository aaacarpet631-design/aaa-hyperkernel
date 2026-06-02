/*
 * AAA Prompt Change Pipeline — a SAFE, human-governed path from an accepted
 * improvement task to a reviewed prompt/process change. No autonomy: nothing
 * here edits a prompt on its own.
 *
 * Lifecycle: draft → submitted → approved → implemented (→ rolled_back) | rejected.
 * Approval is Admin-only and requires a written note, a test-checklist
 * confirmation, and a rollback note. Implementation generates an
 * IMPLEMENTATION PATCH/TASK by default; it only edits a live prompt when a
 * safe, versioned prompt registry adapter has been registered — and even then
 * only behind Admin approval. Every transition is written to the immutable
 * governance ledger.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function rbac() { return global.AAA_RBAC; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function learning() { return global.AAA_GOVERNANCE_LEARNING; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const PROPOSALS = 'gov_prompt_proposals';
  const TASKS = 'gov_improvement_tasks';
  const TRAINING = 'gov_training_queue';
  const STATUSES = ['draft', 'submitted', 'approved', 'implemented', 'rejected', 'rolled_back'];

  // ---- pure helpers (exported for tests) ------------------------------------

  /** Approval requires admin authority + written note + checklist + rollback. */
  function validateApproval(canApprove, opts) {
    opts = opts || {};
    if (!canApprove) return { ok: false, error: 'FORBIDDEN' };
    if (!opts.note || String(opts.note).trim().length < 10) return { ok: false, error: 'APPROVAL_NOTE_REQUIRED' };
    if (opts.checklistConfirmed !== true) return { ok: false, error: 'CHECKLIST_REQUIRED' };
    if (!opts.rollbackNote || String(opts.rollbackNote).trim().length < 5) return { ok: false, error: 'ROLLBACK_NOTE_REQUIRED' };
    return { ok: true };
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }
  function actor(opts) {
    opts = opts || {};
    const uid = cfg().firebaseUid || (cfg().flag ? cfg().flag('firebaseUid', null) : null);
    return { id: opts.actorId || uid || 'local-operator', role: (rbac() && rbac().role) ? rbac().role() : 'unknown' };
  }
  function canApprove() { return !!(rbac() && rbac().can && rbac().can('OVERRIDE_AI_DECISION')); }
  async function get(id) { return (data() && data().get) ? data().get(PROPOSALS, id) : null; }
  async function put(p) { if (data() && data().put) await data().put(PROPOSALS, p.proposalId, p); return p; }
  function newId(p) { return (global.AAA_ID_FACTORY && global.AAA_ID_FACTORY.createId) ? global.AAA_ID_FACTORY.createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)); }

  const Pipeline = {
    STATUSES: STATUSES,
    validateApproval: validateApproval,

    // A safe, versioned prompt registry can be plugged in here. Interface:
    //   getPrompt(agentId) -> string|null
    //   apply(agentId, change) -> { ok, version }
    //   rollback(agentId, version) -> { ok }
    _registry: null,
    registerRegistry(adapter) { this._registry = adapter || null; return this; },
    hasRegistry() { return !!this._registry; },

    /**
     * Create a proposal. Pass a taskId to seed from an accepted improvement
     * task, plus the human-authored proposedChange. Status starts 'draft'.
     */
    async createProposal(input) {
      input = input || {};
      let task = null;
      if (input.taskId && data() && data().get) task = await data().get(TASKS, input.taskId);
      const agentId = input.agentId || (task && task.agentId) || null;
      if (!agentId) return { ok: false, error: 'AGENT_REQUIRED' };
      const proposedChange = input.proposedChange != null ? input.proposedChange : (task && task.recommendedChange) || null;
      if (!proposedChange) return { ok: false, error: 'PROPOSED_CHANGE_REQUIRED' };

      const currentVersion = (this._registry && this._registry.getPrompt) ? this._registry.getPrompt(agentId) : null;
      const who = actor(input);
      const p = {
        proposalId: newId('prop'), taskId: input.taskId || (task && task.taskId) || null, agentId: agentId,
        currentPromptVersion: currentVersion, currentPrompt: currentVersion,
        proposedChange: proposedChange,
        reason: input.reason || (task && task.issue) || null,
        evidenceCases: Array.isArray(input.evidenceCases) ? input.evidenceCases : ((task && task.sourceTrainingCases) || []),
        expectedKpiImpact: input.expectedKpiImpact || null,
        riskLevel: input.riskLevel || 'medium',
        rollbackNotes: input.rollbackNotes || null,
        status: 'draft', applied: false, createdBy: who.id, createdAt: now(), updatedAt: now()
      };
      await put(p);
      await audit('prompt_proposal_created', { proposalId: p.proposalId, taskId: p.taskId, agentId: agentId, riskLevel: p.riskLevel, evidenceCount: p.evidenceCases.length, actorId: who.id, actorRole: who.role, at: p.createdAt });
      return { ok: true, proposal: p };
    },

    async get(proposalId) { return get(proposalId); },
    async list() { return (data() && data().list) ? data().list(PROPOSALS) : []; },

    async submit(proposalId, opts) {
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'draft') return { ok: false, error: 'BAD_TRANSITION', from: p.status };
      const who = actor(opts);
      const upd = Object.assign({}, p, { status: 'submitted', submittedAt: now(), submittedBy: who.id, updatedAt: now() });
      await put(upd);
      await audit('prompt_proposal_submitted', { proposalId: proposalId, agentId: p.agentId, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, proposal: upd };
    },

    /** Admin-only. Requires note + checklist confirmation + rollback note. */
    async approve(proposalId, opts) {
      opts = opts || {};
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'submitted') return { ok: false, error: 'BAD_TRANSITION', from: p.status };
      const v = validateApproval(canApprove(), opts);
      if (!v.ok) { await audit('prompt_proposal_approval_denied', { proposalId: proposalId, error: v.error, actorId: actor(opts).id, at: now() }); return { ok: false, error: v.error }; }
      const who = actor(opts);
      const upd = Object.assign({}, p, {
        status: 'approved', approvedBy: who.id, approvedAt: now(),
        approvalNote: String(opts.note).trim(), rollbackNote: String(opts.rollbackNote).trim(), checklistConfirmed: true, updatedAt: now()
      });
      await put(upd);
      await audit('prompt_proposal_approved', { proposalId: proposalId, agentId: p.agentId, actorId: who.id, actorRole: who.role, note: upd.approvalNote, rollbackNote: upd.rollbackNote, at: now() });
      return { ok: true, proposal: upd };
    },

    async reject(proposalId, opts) {
      opts = opts || {};
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status === 'implemented' || p.status === 'rolled_back') return { ok: false, error: 'BAD_TRANSITION', from: p.status };
      const who = actor(opts);
      const upd = Object.assign({}, p, { status: 'rejected', rejectedBy: who.id, rejectedAt: now(), rejectReason: opts.reason || null, updatedAt: now() });
      await put(upd);
      await audit('prompt_proposal_rejected', { proposalId: proposalId, agentId: p.agentId, reason: opts.reason || null, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, proposal: upd };
    },

    /**
     * Implement an APPROVED proposal. With no safe registry this produces an
     * implementation patch/task only (applied:false). With a registry it applies
     * the change behind Admin approval (applied:true). Rejected/unapproved
     * proposals cannot be implemented.
     */
    async implement(proposalId, opts) {
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'approved') return { ok: false, error: 'NOT_APPROVED', from: p.status };
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const who = actor(opts);

      let applied = false, appliedVersion = null, patch = null;
      if (this._registry && this._registry.apply) {
        const r = await this._registry.apply(p.agentId, p.proposedChange);
        if (!r || r.ok === false) return { ok: false, error: 'REGISTRY_APPLY_FAILED', detail: r && r.error };
        applied = true; appliedVersion = r.version != null ? r.version : null;
      } else {
        // No safe registry → never auto-edits a prompt; emit a manual patch/task.
        patch = { agentId: p.agentId, change: p.proposedChange, fromVersion: p.currentPromptVersion, instructions: 'Apply manually and record the new version; no safe prompt registry is configured.' };
      }
      const upd = Object.assign({}, p, { status: 'implemented', applied: applied, appliedVersion: appliedVersion, implementationPatch: patch, implementedBy: who.id, implementedAt: now(), updatedAt: now() });
      await put(upd);
      await audit('prompt_proposal_implemented', { proposalId: proposalId, agentId: p.agentId, applied: applied, appliedVersion: appliedVersion, viaRegistry: !!this._registry, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, proposal: upd, applied: applied, patch: patch };
    },

    /** Roll back an implemented proposal (tracked even if applied manually). */
    async rollback(proposalId, opts) {
      opts = opts || {};
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'implemented') return { ok: false, error: 'BAD_TRANSITION', from: p.status };
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const who = actor(opts);
      let registryRolledBack = false;
      if (p.applied && this._registry && this._registry.rollback) {
        try { const r = await this._registry.rollback(p.agentId, p.currentPromptVersion); registryRolledBack = !!(r && r.ok); } catch (_) {}
      }
      const upd = Object.assign({}, p, { status: 'rolled_back', rolledBackBy: who.id, rolledBackAt: now(), rollbackReason: opts.reason || null, rollbackManual: !registryRolledBack, updatedAt: now() });
      await put(upd);
      await audit('prompt_proposal_rolled_back', { proposalId: proposalId, taskId: p.taskId, agentId: p.agentId, manual: !registryRolledBack, reason: opts.reason || null, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, proposal: upd, manual: !registryRolledBack };
    },

    /** PII-stripped evidence (the linked training cases) for review/export. */
    async exportEvidence(proposalId, opts) {
      const p = await get(proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const samples = [];
      for (const id of (p.evidenceCases || [])) {
        const entry = (data() && data().get) ? await data().get(TRAINING, id) : null;
        if (entry && learning() && learning().toSample) samples.push(learning().toSample(entry));
      }
      const jsonl = (learning() && learning().toJSONL) ? learning().toJSONL(samples) : samples.map(function (s) { return JSON.stringify(s); }).join('\n');
      const who = actor(opts);
      await audit('prompt_evidence_exported', { proposalId: proposalId, count: samples.length, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, jsonl: jsonl, count: samples.length };
    }
  };

  global.AAA_PROMPT_PIPELINE = Pipeline;
})(typeof window !== 'undefined' ? window : this);
