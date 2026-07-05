/*
 * AAA Tenant Model Policy — per-tenant model routing, FAIL-CLOSED.
 *
 * Some tenants cannot use some models: data-residency contracts, restricted
 * markets, retention requirements. This module is the policy seam the router
 * boundary consults BEFORE any model call is dispatched:
 *
 *   setPolicy(policy)        owner-only (RBAC MANAGE_GOVERNANCE when present),
 *                            persisted per-workspace, audited
 *   pick(preferredModel)     preferred model if allowed, else the best-ranked
 *                            allowed substitute, else {ok:false, denial} —
 *                            and the denial itself is AUDITED (observable)
 *   marketAllowed(country)   restricted-market check for dispatch surfaces
 *
 * Fail-closed semantics: with a policy installed, an allowlist means exactly
 * what it says — a model not on it (or denied, or violating residency) is
 * never called, and when nothing is allowed the caller gets NO_ALLOWED_MODEL
 * instead of a quiet fallback. With NO policy installed behavior is unchanged
 * (this is an additive seam, not a rewrite).
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'tenant_model_policies';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function rbac() { return global.AAA_RBAC; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  // Model → deployment regions. Extendable at runtime (registerModelRegions)
  // so new models/providers declare where they can serve from. 'global'
  // satisfies any residency requirement that is not explicitly listed.
  const MODEL_REGIONS = {
    'claude-opus-4-8': ['global', 'us'],
    'claude-sonnet-4-6': ['global', 'us'],
    'claude-haiku-4-5': ['global', 'us']
  };

  // Capability order for substitution (best allowed model wins).
  const RANK = { 'claude-haiku-4-5': 1, 'claude-sonnet-4-6': 2, 'claude-opus-4-8': 3 };

  function knownModels() {
    return Object.keys(MODEL_REGIONS).sort(function (a, b) { return (RANK[b] || 0) - (RANK[a] || 0); });
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) await ledger().append(type, payload); } catch (_) { /* best-effort */ }
  }

  const Policy = {
    COLLECTION: COLLECTION,

    /** Declare where a model can serve from (adapters register new models here). */
    registerModelRegions: function (model, regions) {
      if (!model || !Array.isArray(regions) || !regions.length) return { ok: false, error: 'BAD_REGIONS' };
      MODEL_REGIONS[model] = regions.slice();
      return { ok: true, model: model };
    },
    modelRegions: function (model) { return (MODEL_REGIONS[model] || []).slice(); },

    /**
     * Install the active tenant's policy. Owner-gated when RBAC is present.
     * policy: { allowedModels?:[], deniedModels?:[], residency?:'us'|'eu'|…,
     *           restrictedMarkets?:['XX'], note? }
     */
    setPolicy: async function (policy) {
      const p = policy || {};
      const r = rbac();
      if (r && r.can && !r.can('MANAGE_GOVERNANCE')) return { ok: false, error: 'FORBIDDEN', required: 'MANAGE_GOVERNANCE' };
      if (p.allowedModels != null && (!Array.isArray(p.allowedModels) || !p.allowedModels.length)) {
        return { ok: false, error: 'BAD_POLICY', reason: 'allowedModels must be a non-empty array or omitted' };
      }
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const rec = {
        id: ws(), workspaceId: ws(),
        allowedModels: p.allowedModels || null,
        deniedModels: Array.isArray(p.deniedModels) ? p.deniedModels : [],
        residency: p.residency || null,
        restrictedMarkets: Array.isArray(p.restrictedMarkets) ? p.restrictedMarkets.map(function (c) { return String(c).toUpperCase(); }) : [],
        note: p.note || null, updatedAt: nowISO()
      };
      await data().put(COLLECTION, rec.id, rec);
      await audit('tenant.model.policy', { workspaceId: rec.workspaceId, allowed: rec.allowedModels, denied: rec.deniedModels, residency: rec.residency, restrictedMarkets: rec.restrictedMarkets });
      return { ok: true, policy: rec };
    },

    /** The active tenant's policy, or null (null = seam inactive, behavior unchanged). */
    getPolicy: async function () {
      if (!data()) return null;
      return data().get(COLLECTION, ws());
    },

    clearPolicy: async function () {
      const r = rbac();
      if (r && r.can && !r.can('MANAGE_GOVERNANCE')) return { ok: false, error: 'FORBIDDEN', required: 'MANAGE_GOVERNANCE' };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      await data().put(COLLECTION, ws(), null);
      await audit('tenant.model.policy', { workspaceId: ws(), cleared: true });
      return { ok: true };
    },

    /** Pure verdict for one model under one policy record. */
    evaluate: function (model, policy) {
      if (!policy) return { allowed: true, reason: 'no policy' };
      if ((policy.deniedModels || []).indexOf(model) !== -1) return { allowed: false, reason: 'model is denied for this tenant' };
      if (policy.allowedModels && policy.allowedModels.indexOf(model) === -1) return { allowed: false, reason: 'model is not on the tenant allowlist' };
      if (policy.residency) {
        const regions = MODEL_REGIONS[model];
        if (!regions) return { allowed: false, reason: 'unknown model has no declared regions (fail closed)' };
        if (regions.indexOf(policy.residency) === -1 && regions.indexOf('global') === -1) {
          return { allowed: false, reason: 'model cannot serve residency "' + policy.residency + '"' };
        }
      }
      return { allowed: true, reason: 'permitted by tenant policy' };
    },

    /**
     * The router-boundary call: preferred model if allowed, else the
     * best-ranked allowed substitute, else an AUDITED denial. Fail-closed.
     */
    pick: async function (preferredModel) {
      const policy = await this.getPolicy();
      if (!policy) return { ok: true, model: preferredModel, substituted: false, policy: false };
      const pref = this.evaluate(preferredModel, policy);
      if (pref.allowed) return { ok: true, model: preferredModel, substituted: false, policy: true };
      const candidates = knownModels().filter(function (m) { return m !== preferredModel; });
      for (const m of candidates) {
        if (this.evaluate(m, policy).allowed) {
          await audit('tenant.model.substituted', { workspaceId: ws(), preferred: preferredModel, substitute: m, reason: pref.reason });
          return { ok: true, model: m, substituted: true, preferred: preferredModel, reason: pref.reason, policy: true };
        }
      }
      const denial = { workspaceId: ws(), preferred: preferredModel, reason: pref.reason, candidatesTried: candidates.length };
      await audit('tenant.model.denied', denial);
      return { ok: false, error: 'NO_ALLOWED_MODEL', denial: denial };
    },

    /** Restricted-market check for dispatch surfaces (fail-closed on listed markets). */
    marketAllowed: async function (countryCode) {
      const policy = await this.getPolicy();
      if (!policy || !policy.restrictedMarkets || !policy.restrictedMarkets.length) return { ok: true };
      const code = String(countryCode || '').toUpperCase();
      if (policy.restrictedMarkets.indexOf(code) !== -1) {
        const denial = { workspaceId: ws(), country: code, reason: 'market is restricted for this tenant' };
        await audit('tenant.market.denied', denial);
        return { ok: false, error: 'MARKET_RESTRICTED', denial: denial };
      }
      return { ok: true };
    }
  };

  global.AAA_TENANT_MODEL_POLICY = Policy;
})(typeof window !== 'undefined' ? window : this);
