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

    /** Firebase (Google Cloud) project config. */
    get firebaseProjectId() { return read('firebaseProjectId', null); },
    get firebaseApiKey() { return read('firebaseApiKey', null); },
    get firebaseAuthToken() { return read('firebaseAuthToken', null); },
    get firebaseRefreshToken() { return read('firebaseRefreshToken', null); },
    get firebaseUid() { return read('firebaseUid', null); },
    get firebaseRegion() { return read('firebaseRegion', 'us-central1'); },
    get firebaseFunctionUrl() { return read('firebaseFunctionUrl', null); },

    /** Which AI backend the proxy funnel targets: 'claude' (default) or
     *  'nemotron' (NVIDIA-hosted Nemotron). Flip with AAA_CONFIG.set; every
     *  agent call follows automatically — agent-pinned Claude model ids are
     *  mapped server-side, so no callsite changes are needed. */
    get aiProvider() { return read('aiProvider', 'claude'); },
    /** Served Nemotron model name (only the server uses this; here for refs). */
    get nemotronModel() { return read('nemotronModel', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'); },

    /** AI proxy endpoint. Firebase Cloud Function if Firebase is the backend,
     *  else the Supabase edge function. The function name follows aiProvider
     *  (claudeProxy/claude-proxy vs nemotronProxy/nemotron-proxy). Overridable
     *  via proxyUrl (e.g. /api/claude or /api/nemotron on Netlify). */
    get proxyUrl() {
      const explicit = read('proxyUrl', null);
      if (explicit) return explicit;
      const nemotron = this.aiProvider === 'nemotron';
      if (this.firebaseProjectId) {
        return this.firebaseFunctionUrl ||
          ('https://' + this.firebaseRegion + '-' + this.firebaseProjectId + '.cloudfunctions.net/' +
            (nemotron ? 'nemotronProxy' : 'claudeProxy'));
      }
      const url = this.supabaseUrl;
      return url ? url.replace(/\/$/, '') + '/functions/v1/' + (nemotron ? 'nemotron-proxy' : 'claude-proxy') : null;
    },
    /** Vision endpoint (Netlify function by default). */
    get visionEndpoint() { return read('visionEndpoint', '/api/vision'); },
    /** Sync endpoint (Netlify Blobs by default). */
    get syncEndpoint() { return read('syncEndpoint', '/api/sync'); },
    /** Audio transcription endpoint (Netlify Whisper proxy by default). */
    get transcriptionEndpoint() { return read('transcriptionEndpoint', '/api/transcribe'); },
    /** Research Brain endpoint — Netlify proxy to a SEPARATE AI-Q service.
     *  Read-only research/strategy; never touches jobs/quotes/billing/customers. */
    get researchEndpoint() { return read('researchEndpoint', '/api/research'); },
    /** Auto-pilot: let agents act on domain events. Off by default. */
    get autoAgents() { return !!read('autoAgents', false); },
    /** Business name + Google review link used in review-request messages. */
    get businessName() { return read('businessName', 'AAA Carpet'); },
    get reviewUrl() { return read('reviewUrl', null); },
    /** Generic feature-flag / config accessor. */
    flag(key, fallback) { return read(key, fallback); },

    isSupabaseConfigured() { return !!(this.supabaseUrl && this.supabaseAnonKey && this.workspaceId); },
    isFirebaseConfigured() { return !!(this.firebaseProjectId && this.firebaseApiKey && this.workspaceId); },
    isCloudConfigured() { return this.isFirebaseConfigured() || this.isSupabaseConfigured(); },
    isProxyConfigured() { return !!this.proxyUrl && (this.isFirebaseConfigured() || !!this.supabaseAnonKey); },

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
