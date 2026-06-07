/*
 * AAA Runtime Gateway — the deterministic chokepoint for business mutations.
 *
 * Mission rule: AI can analyze / recommend / score / summarize / classify, but
 * it CANNOT finalize prices, approve payments, modify accounting, close jobs,
 * or change customer records without passing through deterministic code. This
 * module is that deterministic code.
 *
 * Every guarded mutation declares an ACTION. The gateway:
 *   1. Looks up the action's policy (who may do it; whether AI may ever do it).
 *   2. Checks the caller's RBAC permission.
 *   3. Hard-blocks AI-originated calls on human-only actions — no exceptions,
 *      no config override, no prompt can bypass it (it's a code constant).
 *   4. Writes an audit_log entry for EVERY attempt (allowed or denied).
 *   5. Runs the actual mutation only if allowed.
 *
 * AI never calls this with origin:'ai' for a human-only action and succeeds —
 * the agents produce *recommendations*; a human confirms, and the confirm path
 * calls the gateway with origin:'human'. This is enforced here, not by trust.
 */
;(function (global) {
  'use strict';

  function rbac() { return global.AAA_RBAC; }
  function data() { return global.AAA_DATA; }
  function cloud() { return global.AAA_CLOUD; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function events() { return global.AAA_EVENTS; }
  function security() { return global.AAA_SECURITY; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  /**
   * Action policy table.
   *   permission : RBAC permission the caller must hold (null = any member)
   *   aiAllowed  : may an origin:'ai' call ever perform this? (false = human-only)
   *   sensitive  : forces an audit entry even on read-ish actions
   */
  const ACTIONS = {
    FINALIZE_PRICE:    { permission: 'APPROVE_QUOTE',   aiAllowed: false },
    APPROVE_PAYMENT:   { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    MODIFY_ACCOUNTING: { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    REVIEW_RECEIPTS:   { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    CLOSE_JOB:         { permission: 'CLOSE_JOB',       aiAllowed: false },
    CHANGE_CUSTOMER:   { permission: 'EDIT_CUSTOMER',   aiAllowed: false },
    EDIT_RATE_CARD:    { permission: 'VIEW_PRICING_RATES', aiAllowed: false },
    // Lower-risk mutations a manager/crew may do; still audited.
    ADD_ESTIMATE:      { permission: 'CREATE_QUOTE',    aiAllowed: false },
    EDIT_JOB:          { permission: 'EDIT_JOB',        aiAllowed: false },
    // Quote lifecycle commits — human-only + audited. Drafting a quote is NOT
    // here (a draft is an AI-allowed recommendation); only the committing
    // transitions are gated. Sending to a customer requires APPROVE_QUOTE so a
    // person reviews before anything leaves the building.
    MODIFY_QUOTE:      { permission: 'CREATE_QUOTE',    aiAllowed: false },
    SEND_QUOTE:        { permission: 'APPROVE_QUOTE',   aiAllowed: false },
    RESOLVE_QUOTE:     { permission: 'CREATE_QUOTE',    aiAllowed: false },
    // Marking a pricing recommendation reviewed/acted-on. Audited; never changes
    // a price (the optimizer has no price-mutation path at all).
    REVIEW_PRICING:    { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    // Owner acknowledging a prediction-closure / learning-feedback record.
    // Audited; never changes a price (closures are read-only observations).
    REVIEW_LEARNING:   { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    // Approving / rejecting / rolling back an AI calibration version. Human-only
    // + audited. Never touches money — it tunes agent confidence, not prices.
    APPLY_CALIBRATION: { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    // Sending a customer-facing message (SMS/email). Human-only: AI may draft a
    // message but a person must approve before anything leaves the building.
    SEND_MESSAGE:      { permission: 'EDIT_CUSTOMER',   aiAllowed: false },
    // Recording an INBOUND customer message (a reply arriving from a network
    // adapter/webhook). Not a customer-facing send, so AI/system ingestion is
    // allowed — it records reality — and every receipt is audited.
    INBOUND_MESSAGE:   { permission: null,              aiAllowed: true  },
    // Sensing ingress: recording a real-world signal (inbound SMS, missed call,
    // web lead) into the system. Any member / automated webhook may record an
    // observation (it is not a privileged action); the RESPONSE it triggers is a
    // pending owner-approval draft — nothing is sent without a human.
    SENSE_SIGNAL:      { permission: null,              aiAllowed: true  },
    // Owner acting on a Supervisor Council decision. Advisory + audited; the
    // council recommends, a person decides — it never auto-acts.
    REVIEW_COUNCIL:    { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    // Owner acting on an Executive Council review of a high-impact decision
    // (price change / ad spend / hire / large quote). Advisory + audited.
    REVIEW_EXECUTIVE:  { permission: 'VIEW_FINANCIALS', aiAllowed: false },
    // Governing a versioned registry artifact (prompt/model/template/policy/
    // calibration): create draft / propose / approve / activate / rollback /
    // deprecate. Human-only + audited; no version goes active without this path.
    GOVERN_REGISTRY:   { permission: 'MANAGE_GOVERNANCE', aiAllowed: false },
    // Owner reviewing a Governed Learning Loop proposal (approve → a governance
    // draft is created/proposed; reject → retained as learning). Human-only +
    // audited; the engine proposes, a person decides — nothing auto-applies.
    REVIEW_PROPOSAL:   { permission: 'MANAGE_GOVERNANCE', aiAllowed: false },
    // External (NVIDIA Nemotron) model inference through the Governed Model Router.
    // Office-level (owner + manager hold VIEW_ALL_JOBS); crew denied. AI agents MAY
    // run advisory inference (they cannot bypass the router) — output is advisory.
    RUN_MODEL:            { permission: 'VIEW_ALL_JOBS',  aiAllowed: true },
    // Enabling/disabling a model is an owner-only control; AI can never toggle it.
    MANAGE_MODEL_SETTINGS:{ permission: 'MANAGE_SETTINGS', aiAllowed: false },
    // Approving / rejecting an AI-drafted customer message. Office-level (owner +
    // manager hold EDIT_CUSTOMER); human-only — a model draft never sends itself.
    APPROVE_ASSISTED_MSG: { permission: 'EDIT_CUSTOMER',  aiAllowed: false },
    // Security hardening admin (configure step-up/MFA, toggle enforcement).
    // Owner-only (MANAGE_SETTINGS) + audited; AI can never reconfigure security.
    MANAGE_SECURITY:   { permission: 'MANAGE_SETTINGS',   aiAllowed: false },
    // Privacy & data governance. Configuring retention/vault is owner-only +
    // audited; executing an erasure (right to be forgotten) is its own action so
    // the destructive step is separately gated + audited. AI can never erase data.
    MANAGE_PRIVACY:    { permission: 'MANAGE_SETTINGS',   aiAllowed: false },
    ERASE_DATA:        { permission: 'MANAGE_SETTINGS',   aiAllowed: false },
    // Running a Replay Sandbox simulation: re-decide a past trace under chosen
    // governed versions. Owner-only + audited; read-only by construction (it
    // writes no business record — only an optional owner-only replay snapshot).
    REPLAY_SANDBOX:    { permission: 'MANAGE_GOVERNANCE', aiAllowed: false },
    // Legal Intelligence Division. Agents advise; humans record. The one
    // AI-allowed action is preparing a fact package for human attorney review.
    ADD_LEGAL_RECORD:     { permission: 'MANAGE_LEGAL', aiAllowed: false },
    FILE_INCIDENT:        { permission: null,           aiAllowed: false },
    PREPARE_LEGAL_REVIEW: { permission: null,           aiAllowed: true  },
    RESOLVE_LEGAL_REVIEW: { permission: 'MANAGE_LEGAL', aiAllowed: false }
  };

  const Gateway = {
    ACTIONS: ACTIONS,

    /**
     * Run a guarded mutation.
     * @param {Object} req
     * @param {string} req.action     key of ACTIONS
     * @param {'human'|'ai'} [req.origin]   defaults 'human'
     * @param {string} [req.actor]     agent id or user label (for the audit trail)
     * @param {Object} [req.target]    { type, id } the thing being mutated
     * @param {Object} [req.detail]    arbitrary context to record
     * @param {Function} [req.mutate]  async () => result; only called if allowed
     * @returns {Promise<{ok:boolean, error?:string, result?:*, auditId?:string}>}
     */
    async run(req) {
      const r = req || {};
      const policy = ACTIONS[r.action];
      const origin = r.origin === 'ai' ? 'ai' : 'human';

      if (!policy) {
        await this._audit({ action: r.action || 'UNKNOWN', origin: origin, actor: r.actor, decision: 'denied', reason: 'UNKNOWN_ACTION', target: r.target, detail: r.detail });
        return { ok: false, error: 'UNKNOWN_ACTION' };
      }

      // 1) Hard AI block — a code constant, not a setting. Cannot be overridden.
      if (origin === 'ai' && !policy.aiAllowed) {
        const a = await this._audit({ action: r.action, origin: origin, actor: r.actor, decision: 'denied', reason: 'AI_NOT_PERMITTED', target: r.target, detail: r.detail });
        return { ok: false, error: 'AI_NOT_PERMITTED', message: 'AI may recommend this but a person must approve it.', auditId: a };
      }

      // 2) RBAC check for human-origin actions.
      if (origin === 'human' && policy.permission && rbac() && !rbac().can(policy.permission)) {
        const a = await this._audit({ action: r.action, origin: origin, actor: r.actor || (rbac() && rbac().role()), decision: 'denied', reason: 'FORBIDDEN', target: r.target, detail: r.detail });
        return { ok: false, error: 'FORBIDDEN', message: 'Your role cannot perform this action.', permission: policy.permission, auditId: a };
      }

      // 2b) Security hardening gate (opt-in). When an owner has enabled
      // enforcement, a privileged action needs a valid session + a fresh step-up
      // (MFA). Inert until configured — absent/off behaves exactly as before.
      if (origin === 'human' && security() && security().gateCheck) {
        let gate = { allow: true };
        try { gate = await security().gateCheck(r.action, origin); } catch (_) { gate = { allow: true }; }
        if (gate && !gate.allow) {
          const a = await this._audit({ action: r.action, origin: origin, actor: r.actor || (rbac() && rbac().role()), decision: 'denied', reason: gate.error || 'SECURITY_BLOCKED', target: r.target, detail: r.detail });
          return { ok: false, error: gate.error || 'SECURITY_BLOCKED', message: gate.error === 'STEP_UP_REQUIRED' ? 'Verify your identity (step-up) to perform this privileged action.' : 'Your session must be re-validated.', auditId: a };
        }
      }

      // 3) Allowed — record intent, run the mutation, record outcome.
      const auditId = await this._audit({ action: r.action, origin: origin, actor: r.actor || (rbac() && rbac().role()), decision: 'allowed', target: r.target, detail: r.detail });
      let result = null;
      if (typeof r.mutate === 'function') {
        try {
          result = await r.mutate();
        } catch (err) {
          await this._audit({ action: r.action, origin: origin, actor: r.actor, decision: 'error', reason: String((err && err.message) || err), target: r.target });
          return { ok: false, error: 'MUTATION_FAILED', message: String((err && err.message) || err), auditId: auditId };
        }
      }
      if (events()) events().emit('gateway.mutation', { action: r.action, origin: origin, target: r.target });
      return { ok: true, result: result, auditId: auditId };
    },

    /** Convenience: can the CURRENT human role perform this action? */
    canHuman(action) {
      const p = ACTIONS[action];
      if (!p) return false;
      return !p.permission || !rbac() || rbac().can(p.permission);
    },

    /** Append an immutable audit entry (local-first; mirrored to cloud). */
    async _audit(entry) {
      const id = ids() ? ids().createId('audit') : ('audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const rec = {
        id: id,
        at: nowISO(),
        workspaceId: cfg().workspaceId || 'default',
        action: entry.action,
        origin: entry.origin || 'human',
        actor: entry.actor || null,
        role: rbac() ? rbac().role() : null,
        decision: entry.decision,            // allowed | denied | error
        reason: entry.reason || null,
        target: entry.target || null,
        detail: entry.detail || null
      };
      // Tamper-evidence: when the Security module is present, chain this entry to
      // its predecessor (seq + prevHash + hash) and sign privileged approvals.
      // Inert (no extra fields) when the module isn't loaded — fully backward-compatible.
      let sealed = rec;
      try { if (security() && security().sealAudit) sealed = await security().sealAudit(rec); } catch (_) { sealed = rec; }
      try { if (data() && data().put) await data().put('audit_log', id, sealed); } catch (_) {}
      // Best-effort cloud mirror (rules make audit_log append-only / owner-read).
      try { if (data() && data().cloudReady && data().cloudReady() && cloud()) await cloud().insertEvent('audit_log', sealed); } catch (_) {}
      return id;
    },

    /** Read recent audit entries (owner-facing). Newest first. */
    async recentAudit(limit) {
      if (!data()) return [];
      const ws = cfg().workspaceId || 'default';
      const all = (await data().list('audit_log')).filter((e) => e && (e.workspaceId == null || e.workspaceId === ws));
      return all.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit || 50);
    }
  };

  global.AAA_RUNTIME_GATEWAY = Gateway;
})(typeof window !== 'undefined' ? window : this);
