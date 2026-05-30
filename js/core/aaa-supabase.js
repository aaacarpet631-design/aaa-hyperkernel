/*
 * AAA Supabase — tiny dependency-free REST + edge-function client.
 *
 * No SDK, no build step. Uses the project's anon key (and the signed-in user's
 * access token when present) against PostgREST. Every method is a no-op that
 * resolves { ok:false, error:'NOT_CONFIGURED' } until AAA_CONFIG has a project
 * URL + anon key, so callers never need to branch on configuration.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }

  function headers(extra) {
    const c = cfg();
    const token = c.accessToken || c.supabaseAnonKey;
    return Object.assign({
      'content-type': 'application/json',
      apikey: c.supabaseAnonKey || '',
      authorization: 'Bearer ' + (token || '')
    }, extra || {});
  }

  function configured() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey);
  }

  async function rest(path, options) {
    if (!configured()) return { ok: false, error: 'NOT_CONFIGURED' };
    const base = cfg().supabaseUrl.replace(/\/$/, '');
    try {
      const res = await fetch(base + '/rest/v1' + path, options);
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

    /** Insert rows. */
    insert(table, rows) {
      return rest('/' + table, { method: 'POST', headers: headers({ Prefer: 'return=representation' }), body: JSON.stringify(rows) });
    },

    /** Upsert rows, resolving conflicts on `onConflict` columns (e.g. 'workspace_id,client_id'). */
    upsert(table, rows, onConflict) {
      const q = onConflict ? '?on_conflict=' + encodeURIComponent(onConflict) : '';
      return rest('/' + table + q, {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(rows)
      });
    },

    /** Select with a raw PostgREST query string, e.g. select('jobs', 'select=*&workspace_id=eq.' + id). */
    select(table, query) {
      return rest('/' + table + (query ? '?' + query : ''), { method: 'GET', headers: headers() });
    },

    /** Call the server-side Claude proxy edge function. */
    async callProxy(payload) {
      const c = cfg();
      if (!c.proxyUrl || !c.supabaseAnonKey) return { ok: false, error: 'PROXY_NOT_CONFIGURED' };
      try {
        const res = await fetch(c.proxyUrl, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(Object.assign({ workspace_id: c.workspaceId || null }, payload || {}))
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) return { ok: false, error: 'PROXY_ERROR', detail: data };
        return data; // { ok:true, text, content, usage }
      } catch (err) {
        return { ok: false, error: 'PROXY_NETWORK', message: String((err && err.message) || err) };
      }
    }
  };

  global.AAA_SUPABASE = api;
})(typeof window !== 'undefined' ? window : this);
