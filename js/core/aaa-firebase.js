/*
 * AAA Firebase — dependency-free client (no SDK bundle, no build step).
 *
 * Talks to Firebase over REST:
 *   - Firestore REST  → workspace-scoped document upserts (shared memory)
 *   - Identity Toolkit → email/password sign-in (so security rules apply)
 *   - Cloud Function  → the server-side Claude proxy (key stays off-device)
 *
 * Documents live at  workspaces/{workspaceId}/{collection}/{clientId}
 * so a local-first record maps to exactly one doc (idempotent PATCH upsert).
 * Every method no-ops with { ok:false, error:'NOT_CONFIGURED' } until config
 * is present — never fabricates.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function configured() { const c = cfg(); return !!(c.firebaseProjectId && c.firebaseApiKey && c.workspaceId); }

  function docBase() {
    return 'https://firestore.googleapis.com/v1/projects/' + cfg().firebaseProjectId + '/databases/(default)/documents';
  }
  function authHeaders() {
    const h = { 'content-type': 'application/json' };
    const tok = cfg().firebaseAuthToken;
    if (tok) h.authorization = 'Bearer ' + tok;
    return h;
  }

  // ---- Firestore typed-value encoding -------------------------------------
  function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
  }
  function encodeFields(obj) {
    const f = {};
    Object.keys(obj || {}).forEach((k) => { if (obj[k] !== undefined) f[k] = encodeValue(obj[k]); });
    return f;
  }

  async function fbFetch(url, options) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) return { ok: false, error: 'HTTP_' + res.status, detail: data };
      return { ok: true, data: data };
    } catch (err) {
      return { ok: false, error: 'NETWORK', message: String((err && err.message) || err) };
    }
  }

  const api = {
    isConfigured: configured,

    /** Idempotent upsert of one workspace-scoped document keyed by clientId. */
    async upsertEntity(collection, clientId, fields) {
      if (!configured()) return { ok: false, error: 'NOT_CONFIGURED' };
      const ws = cfg().workspaceId;
      const id = encodeURIComponent(String(clientId));
      const url = docBase() + '/workspaces/' + ws + '/' + collection + '/' + id + '?key=' + cfg().firebaseApiKey;
      return fbFetch(url, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ fields: encodeFields(fields) }) });
    },

    /** Append an event document (auto-id) under a workspace collection. */
    async insertEvent(collection, fields) {
      if (!configured()) return { ok: false, error: 'NOT_CONFIGURED' };
      const ws = cfg().workspaceId;
      const url = docBase() + '/workspaces/' + ws + '/' + collection + '?key=' + cfg().firebaseApiKey;
      return fbFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ fields: encodeFields(fields) }) });
    },

    /** Call a server-side AI proxy Cloud Function. Defaults to the active
     *  proxyUrl; pass an explicit url to target a specific function (e.g. the
     *  Nemotron content-safety proxy, regardless of aiProvider). */
    async callProxy(payload, url) {
      const target = url || cfg().proxyUrl;
      if (!target) return { ok: false, error: 'PROXY_NOT_CONFIGURED' };
      try {
        const res = await fetch(target, { method: 'POST', headers: authHeaders(), body: JSON.stringify(Object.assign({ workspace_id: cfg().workspaceId || null }, payload || {})) });
        const data = await res.json();
        if (!res.ok || data.ok === false) return { ok: false, error: 'PROXY_ERROR', detail: data };
        return data;
      } catch (err) {
        return { ok: false, error: 'PROXY_NETWORK', message: String((err && err.message) || err) };
      }
    },

    // ---- Firebase Auth (Identity Toolkit REST) ----------------------------
    async signIn(email, password) {
      const c = cfg();
      if (!c.firebaseApiKey) return { ok: false, error: 'NOT_CONFIGURED' };
      const r = await fbFetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + c.firebaseApiKey, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
      });
      if (!r.ok) return r;
      this._storeSession(r.data);
      return { ok: true, uid: r.data.localId, email: r.data.email };
    },
    async signUp(email, password) {
      const c = cfg();
      if (!c.firebaseApiKey) return { ok: false, error: 'NOT_CONFIGURED' };
      const r = await fbFetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + c.firebaseApiKey, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
      });
      if (!r.ok) return r;
      this._storeSession(r.data);
      return { ok: true, uid: r.data.localId, email: r.data.email };
    },
    _storeSession(d) {
      if (cfg().set) cfg().set({ firebaseAuthToken: d.idToken, firebaseRefreshToken: d.refreshToken, firebaseUid: d.localId });
    },
    currentUser() { return cfg().firebaseUid || null; },
    signOut() { if (cfg().set) cfg().set({ firebaseAuthToken: null, firebaseRefreshToken: null, firebaseUid: null }); }
  };

  global.AAA_FIREBASE = api;
})(typeof window !== 'undefined' ? window : this);
