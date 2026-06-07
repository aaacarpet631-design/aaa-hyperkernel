/*
 * AAA Cloud — backend-agnostic provider resolver.
 *
 * Lets the data layer and agents talk to "the cloud" without caring whether
 * it's Firebase or Supabase. Picks whichever is configured (Firebase first,
 * since that's the chosen backend). Everything no-ops cleanly when neither is
 * configured, so the app stays fully local-first.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }

  // Map a local (camelCase) entity to Supabase's snake_case columns for the
  // simple, single-row collections. (customers/jobs/estimates use the richer
  // mirror path in aaa-data.) Keeps the Supabase backend working unchanged.
  function supabaseRow(collection, clientId, e) {
    const ws = cfg().workspaceId;
    const base = { workspace_id: ws };
    if (clientId != null) base.client_id = clientId;
    switch (collection) {
      case 'outcomes': return Object.assign(base, { result: e.result, final_amount: e.finalAmount != null ? e.finalAmount : null, notes: e.notes || null });
      case 'agent_decisions': return Object.assign(base, { agent: e.agent || 'unknown', decision: e.decision || '', confidence: e.confidence != null ? e.confidence : null, score: e.score != null ? e.score : null });
      case 'kpi_snapshots': return Object.assign(base, { period: e.period || 'day', metrics: e.metrics || {} });
      case 'agent_logs': return Object.assign(base, { agent: e.agent || 'system', message: e.message || '', context: e.context || {} });
      default: return Object.assign(base, e);
    }
  }

  const Cloud = {
    /** 'firebase' | 'supabase' | null */
    provider() {
      const c = cfg();
      if (global.AAA_FIREBASE && c.isFirebaseConfigured && c.isFirebaseConfigured()) return 'firebase';
      if (global.AAA_SUPABASE && c.isSupabaseConfigured && c.isSupabaseConfigured()) return 'supabase';
      return null;
    },
    isConfigured() { return this.provider() != null; },

    async callProxy(payload, url) {
      const p = this.provider();
      if (p === 'firebase') return global.AAA_FIREBASE.callProxy(payload, url);
      if (p === 'supabase') return global.AAA_SUPABASE.callProxy(payload, url);
      return { ok: false, error: 'PROXY_NOT_CONFIGURED' };
    },

    /** Idempotent per-entity upsert keyed by clientId. */
    async upsertEntity(collection, clientId, entity) {
      const p = this.provider();
      if (p === 'firebase') return global.AAA_FIREBASE.upsertEntity(collection, clientId, Object.assign({ clientId: clientId }, entity));
      if (p === 'supabase') return global.AAA_SUPABASE.upsert(collection, [supabaseRow(collection, clientId, entity)], 'workspace_id,client_id');
      return { ok: false, error: 'NOT_CONFIGURED' };
    },

    /** List a workspace-scoped collection (for governance hydrate/pull). Firebase only. */
    async listEntities(collection) {
      const p = this.provider();
      if (p === 'firebase') return global.AAA_FIREBASE.listEntities(collection);
      return { ok: false, error: 'NOT_SUPPORTED', provider: p };
    },

    /** Append an event (auto-id) — for logs / kpi snapshots. */
    async insertEvent(collection, fields) {
      const p = this.provider();
      if (p === 'firebase') return global.AAA_FIREBASE.insertEvent(collection, fields);
      if (p === 'supabase') return global.AAA_SUPABASE.insert(collection, [supabaseRow(collection, null, fields)]);
      return { ok: false, error: 'NOT_CONFIGURED' };
    },

    // Auth passthrough (Firebase only for now).
    canSignIn() { return this.provider() === 'firebase' && !!global.AAA_FIREBASE; },
    signIn(email, pw) { return this.canSignIn() ? global.AAA_FIREBASE.signIn(email, pw) : Promise.resolve({ ok: false, error: 'NO_AUTH_PROVIDER' }); },
    signUp(email, pw) { return this.canSignIn() ? global.AAA_FIREBASE.signUp(email, pw) : Promise.resolve({ ok: false, error: 'NO_AUTH_PROVIDER' }); },
    currentUser() { return this.canSignIn() ? global.AAA_FIREBASE.currentUser() : null; },
    signOut() { if (this.canSignIn()) global.AAA_FIREBASE.signOut(); }
  };

  global.AAA_CLOUD = Cloud;
})(typeof window !== 'undefined' ? window : this);
