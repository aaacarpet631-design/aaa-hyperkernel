/*
 * AAA Governance Sync — cloud persistence for the governance subsystem.
 *
 * The governance collections (decisions, outcomes, scorecards, escalations, the
 * immutable audit ledger, the prompt registry, …) are local-first by default.
 * This module mirrors them to the workspace's cloud backend so they survive a
 * device loss and are shared across the team, and hydrates them back on a new
 * device. It is best-effort and additive — a cloud failure never blocks a local
 * governance write.
 *
 * Backend: Firestore (schemaless workspace subcollections fit governance records
 * directly). Supabase deployments keep governance local until a relational
 * schema is added — push/pull no-op rather than corrupt.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cloud() { return global.AAA_CLOUD; }
  function cfg() { return global.AAA_CONFIG || {}; }

  // Collection → the field that holds its document id (for cloud keying).
  const ID_FIELD = {
    gov_agent_decisions: 'decisionId',
    gov_training_queue: 'id',
    gov_agent_scorecards: 'agentType',
    gov_scorecard_history: 'id',
    gov_retraining_recommendations: 'id',
    gov_improvement_tasks: 'taskId',
    gov_prompt_proposals: 'proposalId',
    gov_prompt_registry: 'agentId',
    gov_prompt_version_proposals: 'proposalId',
    governance_cases: 'id',
    governance_review_queue: 'id',
    governance_alerts: 'id',
    governance_escalations: 'id',
    governance_audit: 'id'
  };
  const COLLECTIONS = Object.keys(ID_FIELD);

  function idOf(collection, rec) {
    const f = ID_FIELD[collection];
    if (f && rec && rec[f] != null) return rec[f];
    return rec && rec.id != null ? rec.id : null;
  }

  const Sync = {
    COLLECTIONS: COLLECTIONS,
    _suspendMirror: false,
    isCollection: function (c) { return Object.prototype.hasOwnProperty.call(ID_FIELD, c); },

    /** Cloud persistence is available (Firestore or Supabase workspace, configured). */
    ready: function () {
      const p = cloud() && cloud().provider ? cloud().provider() : null;
      return !!(cloud() && cloud().isConfigured && cloud().isConfigured() && (p === 'firebase' || p === 'supabase') && cfg().workspaceId);
    },

    /** Mirror one governance record up (best-effort, never throws). */
    async mirror(collection, id, rec) {
      if (this._suspendMirror || !this.ready() || !this.isCollection(collection)) return { ok: false, error: 'SKIPPED' };
      try { return await cloud().upsertGovernance(collection, id, rec); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },

    /** Push every local governance record to the cloud. Returns counts. */
    async push() {
      if (!this.ready()) return { ok: false, error: 'NOT_READY' };
      let pushed = 0;
      for (const c of COLLECTIONS) {
        const recs = (data() && data().list) ? await data().list(c) : [];
        for (const r of (recs || [])) {
          const id = idOf(c, r);
          if (id != null) { try { await cloud().upsertGovernance(c, id, r); pushed++; } catch (_) {} }
        }
      }
      return { ok: true, pushed: pushed };
    },

    /** Pull governance records from the cloud into local storage. Returns counts. */
    async pull() {
      if (!this.ready()) return { ok: false, error: 'NOT_READY' };
      let pulled = 0;
      this._suspendMirror = true; // avoid re-uploading what we just pulled
      try {
        for (const c of COLLECTIONS) {
          const r = await cloud().listGovernance(c);
          if (r && r.ok && Array.isArray(r.items)) {
            for (const item of r.items) {
              const rec = Object.assign({}, item); const id = rec._id != null ? rec._id : idOf(c, rec); delete rec._id;
              if (id != null && data() && data().put) { await data().put(c, id, rec); pulled++; }
            }
          }
        }
      } finally { this._suspendMirror = false; }
      return { ok: true, pulled: pulled };
    },

    /** Hydrate local governance state from the cloud (new device / session). */
    async hydrate() { return this.ready() ? this.pull() : { ok: false, error: 'NOT_READY' }; }
  };

  global.AAA_GOVERNANCE_SYNC = Sync;
})(typeof window !== 'undefined' ? window : this);
