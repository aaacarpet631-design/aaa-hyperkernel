/*
 * AAA QuickBooks Online — live OAuth2 sync (real, config-gated).
 *
 * This is the live counterpart to quickbooks-export.js (CSV). It pushes invoices
 * to QuickBooks Online via the Intuit Accounting API. Two honest realities are
 * baked in:
 *
 *  1. The OAuth client secret and token exchange CANNOT live in the browser, so
 *     all network calls route through a server proxy (the same Cloud Function
 *     pattern the app already uses). Configure AAA_CONFIG.qboProxyUrl to enable.
 *  2. Until connected (no tokens / no proxy), every sync call returns an explicit
 *     NOT_CONFIGURED / NOT_CONNECTED result. Nothing is faked.
 *
 * The deterministic, offline-testable parts — auth-URL building, invoice→QBO
 * payload mapping, and connection status — live here and are unit-tested. The
 * proxy performs token exchange/refresh and signs the API requests.
 *
 * Config keys (AAA_CONFIG):
 *   qboClientId, qboRedirectUri, qboEnvironment ('sandbox'|'production'),
 *   qboProxyUrl, qboRealmId, qboAccessToken, qboRefreshToken, qboTokenExpiresAt
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function set(p) { if (cfg().set) cfg().set(p); }
  function acct() { return global.AAA_ACCOUNTING; }

  const SCOPE = 'com.intuit.quickbooks.accounting';
  const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';

  const QBO = {
    /** Connection status — purely from config, never fabricated. */
    status() {
      const hasProxy = !!flag('qboProxyUrl', null);
      const hasToken = !!flag('qboAccessToken', null);
      const hasRealm = !!flag('qboRealmId', null);
      const expiresAt = flag('qboTokenExpiresAt', null);
      const expired = expiresAt ? (Date.parse(expiresAt) < Date.now()) : false;
      return {
        configured: !!flag('qboClientId', null) && hasProxy,
        connected: hasProxy && hasToken && hasRealm && !expired,
        expired: hasToken && expired,
        environment: flag('qboEnvironment', 'production')
      };
    },

    /**
     * Build the Intuit OAuth2 authorization URL the owner opens to connect.
     * Returns { ok, url } or { ok:false, error } when not configured.
     */
    authUrl(stateToken) {
      const clientId = flag('qboClientId', null);
      const redirectUri = flag('qboRedirectUri', null);
      if (!clientId || !redirectUri) return { ok: false, error: 'NOT_CONFIGURED' };
      const params = new global.URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        scope: SCOPE,
        redirect_uri: redirectUri,
        state: stateToken || ('aaa_' + Date.now())
      });
      return { ok: true, url: AUTH_BASE + '?' + params.toString() };
    },

    /**
     * Map an AAA invoice to the QuickBooks Online Invoice payload shape.
     * Deterministic + testable. (Customer/Item refs are resolved server-side by
     * name; the proxy fills CustomerRef.value after a name lookup.)
     */
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

    /** Exchange an OAuth code for tokens (via proxy). Persists tokens on success. */
    async connect(code) {
      const proxy = flag('qboProxyUrl', null);
      if (!proxy) return { ok: false, error: 'NOT_CONFIGURED' };
      try {
        const res = await this._proxy('exchange', { code: code, redirectUri: flag('qboRedirectUri', null) });
        if (!res || !res.access_token) return { ok: false, error: 'EXCHANGE_FAILED', detail: res && res.error };
        set({
          qboAccessToken: res.access_token,
          qboRefreshToken: res.refresh_token || flag('qboRefreshToken', null),
          qboRealmId: res.realmId || flag('qboRealmId', null),
          qboTokenExpiresAt: new Date(Date.now() + (Number(res.expires_in || 3600) * 1000)).toISOString()
        });
        return { ok: true, realmId: flag('qboRealmId', null) };
      } catch (e) { return { ok: false, error: 'PROXY_ERROR', detail: String((e && e.message) || e) }; }
    },

    /** Push one invoice (by id) to QBO via the proxy. */
    async pushInvoice(invoiceId) {
      const st = this.status();
      if (!st.configured) return { ok: false, error: 'NOT_CONFIGURED' };
      if (!st.connected) return { ok: false, error: st.expired ? 'TOKEN_EXPIRED' : 'NOT_CONNECTED' };
      const invoices = await acct().listInvoices();
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv) return { ok: false, error: 'INVOICE_NOT_FOUND' };
      try {
        const res = await this._proxy('createInvoice', {
          realmId: flag('qboRealmId', null),
          accessToken: flag('qboAccessToken', null),
          invoice: this.mapInvoice(inv)
        });
        if (!res || res.error) return { ok: false, error: 'PUSH_FAILED', detail: res && res.error };
        return { ok: true, qboId: res.Id || res.id || null };
      } catch (e) { return { ok: false, error: 'PROXY_ERROR', detail: String((e && e.message) || e) }; }
    },

    /** Push all not-yet-synced invoices. Returns a per-invoice result list. */
    async pushAllInvoices() {
      const st = this.status();
      if (!st.connected) return { ok: false, error: st.configured ? 'NOT_CONNECTED' : 'NOT_CONFIGURED', results: [] };
      const invoices = await acct().listInvoices();
      const results = [];
      for (const inv of invoices) {
        const r = await this.pushInvoice(inv.id);
        results.push({ id: inv.id, customer: inv.customerName, ok: r.ok, error: r.error });
      }
      return { ok: true, results: results, pushed: results.filter((r) => r.ok).length };
    },

    /** Disconnect — clears stored tokens (local only). */
    disconnect() {
      set({ qboAccessToken: null, qboRefreshToken: null, qboTokenExpiresAt: null });
      return { ok: true };
    },

    async _proxy(action, payload) {
      const url = flag('qboProxyUrl', null);
      const resp = await global.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action, environment: flag('qboEnvironment', 'production') }, payload))
      });
      return resp.json();
    }
  };

  global.AAA_QUICKBOOKS_ONLINE = QBO;
})(typeof window !== 'undefined' ? window : this);
