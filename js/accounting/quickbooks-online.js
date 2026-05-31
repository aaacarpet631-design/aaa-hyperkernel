/*
 * AAA QuickBooks Online (client) — live sync via the server proxy.
 *
 * SECURITY: the browser never holds the QuickBooks client secret OR the OAuth
 * tokens. Token exchange/refresh and all API calls happen in the qboProxy Cloud
 * Function (see functions/qbo-proxy). This client only:
 *   - builds the public OAuth authorize URL (client_id + redirect are public),
 *   - completes connect by handing the `code` to the proxy (which stores tokens
 *     server-side, scoped to the workspace),
 *   - asks the proxy for connection status,
 *   - requests invoice pushes (proxy does the actual QBO write, with approval).
 *
 * Every proxy call carries the Firebase ID token (Authorization: Bearer) so the
 * proxy can verify the user and their workspace membership/role. Until the proxy
 * URL + client id are configured, calls return explicit NOT_CONFIGURED.
 *
 * Config (AAA_CONFIG): qboClientId, qboRedirectUri, qboEnvironment, qboProxyUrl.
 * Cached (non-sensitive): qboConnected, qboRealmId.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function set(p) { if (cfg().set) cfg().set(p); }
  function acct() { return global.AAA_ACCOUNTING; }
  function fb() { return global.AAA_FIREBASE; }

  const SCOPE = 'com.intuit.quickbooks.accounting';
  const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';

  function idToken() {
    if (fb() && fb().idToken) return fb().idToken;
    return flag('firebaseAuthToken', null);
  }
  function workspaceId() { return cfg().workspaceId || flag('workspaceId', null); }

  const QBO = {
    /** Local view of config + cached connection flag. */
    status() {
      const configured = !!flag('qboClientId', null) && !!flag('qboProxyUrl', null) && !!flag('qboRedirectUri', null);
      return {
        configured: configured,
        connected: configured && !!flag('qboConnected', false),
        realmId: flag('qboRealmId', null),
        environment: flag('qboEnvironment', 'production')
      };
    },

    /** Build the Intuit OAuth authorize URL (no secret needed — all public). */
    authUrl(stateToken) {
      const clientId = flag('qboClientId', null);
      const redirectUri = flag('qboRedirectUri', null);
      if (!clientId || !redirectUri) return { ok: false, error: 'NOT_CONFIGURED' };
      const ws = workspaceId() || '';
      const params = new global.URLSearchParams({
        client_id: clientId, response_type: 'code', scope: SCOPE,
        redirect_uri: redirectUri,
        state: (stateToken || 'aaa') + ':' + ws   // ws travels in state for the callback
      });
      return { ok: true, url: AUTH_BASE + '?' + params.toString() };
    },

    /**
     * If the current URL is the OAuth callback (has ?code & ?realmId), finish
     * the connection through the proxy. Returns null if not a callback.
     */
    async handleRedirect() {
      if (typeof global.location === 'undefined') return null;
      const q = new global.URLSearchParams(global.location.search || '');
      const code = q.get('code'); const realmId = q.get('realmId');
      if (!code || !realmId) return null;
      const res = await this.connect(code, realmId);
      // Clean the URL so a refresh doesn't replay the code.
      try { global.history.replaceState({}, '', global.location.pathname); } catch (_) {}
      return res;
    },

    /** Complete OAuth: proxy exchanges the code + stores tokens server-side. */
    async connect(code, realmId) {
      const res = await this._proxy('exchange', { code: code, realmId: realmId, redirectUri: flag('qboRedirectUri', null) });
      if (res && res.ok) { set({ qboConnected: true, qboRealmId: res.realmId || realmId }); return { ok: true, realmId: res.realmId || realmId }; }
      return res || { ok: false, error: 'EXCHANGE_FAILED' };
    },

    /** Refresh the cached connected flag from the proxy (source of truth). */
    async refreshStatus() {
      const res = await this._proxy('status', {});
      if (res && res.ok) { set({ qboConnected: !!res.connected, qboRealmId: res.realmId || flag('qboRealmId', null) }); return res; }
      return res;
    },

    /** Map an AAA invoice to the QBO Invoice payload (deterministic, testable). */
    mapInvoice(inv) {
      if (!inv) return null;
      const items = (inv.items && inv.items.length) ? inv.items : [{ description: 'Services', amount: inv.amount }];
      return {
        _source: 'aaa', _sourceId: inv.id,
        CustomerRef: { name: inv.customerName },
        TxnDate: String(inv.issuedAt || '').slice(0, 10) || undefined,
        Line: items.map((it) => ({
          DetailType: 'SalesItemLineDetail',
          Amount: Number(it.amount || 0),
          Description: it.description || 'Services',
          SalesItemLineDetail: { ItemRef: { name: it.description || 'Services' } }
        })),
        TotalAmt: Number(inv.amount || 0)
      };
    },

    /** Push one invoice by id. `approved` must be true (no silent mutations). */
    async pushInvoice(invoiceId, approved) {
      const st = this.status();
      if (!st.configured) return { ok: false, error: 'NOT_CONFIGURED' };
      if (!st.connected) return { ok: false, error: 'NOT_CONNECTED' };
      if (approved !== true) return { ok: false, error: 'APPROVAL_REQUIRED' };
      const inv = (await acct().listInvoices()).find((i) => i.id === invoiceId);
      if (!inv) return { ok: false, error: 'INVOICE_NOT_FOUND' };
      const res = await this._proxy('createInvoice', { invoice: this.mapInvoice(inv), approved: true });
      return res || { ok: false, error: 'PROXY_ERROR' };
    },

    /** Push all invoices (each requires the same explicit approval). */
    async pushAllInvoices(approved) {
      const st = this.status();
      if (!st.configured) return { ok: false, error: 'NOT_CONFIGURED', results: [] };
      if (!st.connected) return { ok: false, error: 'NOT_CONNECTED', results: [] };
      if (approved !== true) return { ok: false, error: 'APPROVAL_REQUIRED', results: [] };
      const invoices = await acct().listInvoices();
      const results = [];
      for (const inv of invoices) {
        const r = await this.pushInvoice(inv.id, true);
        results.push({ id: inv.id, customer: inv.customerName, ok: !!(r && r.ok), error: r && r.error });
      }
      return { ok: true, results: results, pushed: results.filter((r) => r.ok).length };
    },

    /** Disconnect: proxy deletes the workspace tokens; clear local flag. */
    async disconnect() {
      const res = await this._proxy('disconnect', {});
      set({ qboConnected: false });
      return res || { ok: true };
    },

    async _proxy(action, payload) {
      const url = flag('qboProxyUrl', null);
      if (!url || !flag('qboClientId', null)) return { ok: false, error: 'NOT_CONFIGURED' };
      const token = idToken();
      if (!token) return { ok: false, error: 'NOT_SIGNED_IN' };
      try {
        const resp = await global.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify(Object.assign({ action: action, workspaceId: workspaceId() }, payload))
        });
        return await resp.json();
      } catch (e) { return { ok: false, error: 'NETWORK_ERROR', detail: String((e && e.message) || e) }; }
    }
  };

  global.AAA_QUICKBOOKS_ONLINE = QBO;
})(typeof window !== 'undefined' ? window : this);
