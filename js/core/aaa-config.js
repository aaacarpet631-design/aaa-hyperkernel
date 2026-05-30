/*
 * AAA Config — one place for runtime configuration (Supabase + feature flags).
 *
 * Resolution order (first hit wins): window.AAA_ENV (build-injected) →
 * localStorage 'aaa:config' (owner pastes keys in-app) → safe defaults.
 * NO secrets live in source. When Supabase isn't configured, everything
 * degrades to local-first and cloud calls become no-ops.
 */
;(function (global) {
  'use strict';

  const LS_KEY = 'aaa:config';

  function fromLocal() {
    try { return JSON.parse(global.localStorage.getItem(LS_KEY)) || {}; }
    catch (_) { return {}; }
  }

  const injected = global.AAA_ENV || {};
  let overrides = fromLocal();

  function read(key, fallback) {
    if (injected[key] != null) return injected[key];
    if (overrides[key] != null) return overrides[key];
    return fallback;
  }

  const config = {
    /** Supabase project URL, e.g. https://abc.supabase.co */
    get supabaseUrl() { return read('supabaseUrl', null); },
    /** Supabase anon/public key (safe for the browser). */
    get supabaseAnonKey() { return read('supabaseAnonKey', null); },
    /** The current user's Supabase access token (set after sign-in). */
    get accessToken() { return read('accessToken', null); },
    /** The active workspace (business) id. */
    get workspaceId() { return read('workspaceId', null); },
    /** Claude proxy endpoint (defaults to the Supabase edge function). */
    get proxyUrl() {
      const explicit = read('proxyUrl', null);
      if (explicit) return explicit;
      const url = this.supabaseUrl;
      return url ? url.replace(/\/$/, '') + '/functions/v1/claude-proxy' : null;
    },
    /** Vision endpoint (Netlify function by default). */
    get visionEndpoint() { return read('visionEndpoint', '/api/vision'); },
    /** Sync endpoint (Netlify Blobs by default). */
    get syncEndpoint() { return read('syncEndpoint', '/api/sync'); },
    /** Auto-pilot: let agents act on domain events. Off by default. */
    get autoAgents() { return !!read('autoAgents', false); },
    /** Generic feature-flag / config accessor. */
    flag(key, fallback) { return read(key, fallback); },

    isSupabaseConfigured() { return !!(this.supabaseUrl && this.supabaseAnonKey && this.workspaceId); },
    isProxyConfigured() { return !!this.proxyUrl && !!this.supabaseAnonKey; },

    /** Persist owner-entered config (e.g. from a future settings screen). */
    set(patch) {
      overrides = Object.assign({}, overrides, patch || {});
      try { global.localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch (_) {}
      return overrides;
    },
    all() {
      return {
        supabaseUrl: this.supabaseUrl, hasAnonKey: !!this.supabaseAnonKey,
        workspaceId: this.workspaceId, proxyUrl: this.proxyUrl,
        supabaseConfigured: this.isSupabaseConfigured()
      };
    }
  };

  // Preserve any fields from a pre-existing AAA_CONFIG, but keep our live
  // getters (Object.assign would freeze them to their load-time values).
  const existing = global.AAA_CONFIG;
  if (existing) {
    for (const k in existing) {
      try { if (!(k in config)) config[k] = existing[k]; } catch (_) {}
    }
  }
  global.AAA_CONFIG = config;
})(typeof window !== 'undefined' ? window : this);
