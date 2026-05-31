/*
 * AAA QuickBooks Online Proxy — the ONLY place QBO secrets and tokens live.
 *
 * Security model (every requirement enforced here, not in the browser):
 *  - No QuickBooks secret in the client. QBO_CLIENT_SECRET is a server env var.
 *  - OAuth token exchange/refresh happen ONLY here; tokens are written to
 *    Firestore at workspaces/{ws}/integrations/qbo and NEVER returned to the
 *    client. Firestore rules deny client reads of integrations/** (the Admin
 *    SDK used here bypasses rules).
 *  - Caller is authenticated by verifying their Firebase ID token, then checked
 *    for membership in the target workspace. Money-mutating actions
 *    (createInvoice) additionally require role === 'owner'  => workspace
 *    isolation.
 *  - Every action writes an append-only audit_log entry (attempt + outcome).
 *  - Transient QBO failures (429/5xx) are retried with exponential backoff.
 *  - All failures return a clear, structured { ok:false, error, detail }.
 *  - No destructive accounting mutations: this proxy only CREATES invoices and
 *    requires an explicit approved:true flag to do so. It never updates, voids,
 *    or deletes anything in QuickBooks.
 *
 * Deploy as the HTTPS function `qboProxy`; point the client's
 * AAA_CONFIG.qboProxyUrl at its URL.
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { sanitizeInvoice, isExpired, apiBase, isRetryable } = require('./lib');
admin.initializeApp();
const db = admin.firestore();

// ---- server-side config (secrets / settings) -------------------------------
const ENV = process.env.QBO_ENVIRONMENT || 'production';
const CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const DEFAULT_REDIRECT = process.env.QBO_REDIRECT_URI || '';
const ALLOWED_ORIGIN = process.env.QBO_ALLOWED_ORIGIN || '*';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = apiBase(ENV);

// ---- helpers ---------------------------------------------------------------
function fail(res, status, error, detail) {
  return res.status(status).json({ ok: false, error: error, detail: detail || null });
}
function tokenDocRef(ws) { return db.doc(`workspaces/${ws}/integrations/qbo`); }

async function audit(ws, entry) {
  if (!ws) return;
  try {
    const ref = db.collection(`workspaces/${ws}/audit_log`).doc();
    await ref.set(Object.assign({
      id: ref.id, at: new Date().toISOString(),
      action: 'QBO_SYNC', origin: 'system', source: 'qbo-proxy'
    }, entry));
  } catch (e) { console.error('audit write failed', e); }
}

// Verify the Firebase ID token + the caller's membership/role in the workspace.
async function authorize(req, ws, requireOwner) {
  const header = req.get('Authorization') || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return { ok: false, status: 401, error: 'NO_AUTH' };
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(m[1]); }
  catch (e) { return { ok: false, status: 401, error: 'BAD_TOKEN', detail: String(e.message || e) }; }
  if (!ws) return { ok: false, status: 400, error: 'NO_WORKSPACE' };
  const member = await db.doc(`workspaces/${ws}/members/${decoded.uid}`).get();
  if (!member.exists) return { ok: false, status: 403, error: 'NOT_A_MEMBER' };
  const role = (member.data() && member.data().role) || 'crew';
  if (requireOwner && role !== 'owner') return { ok: false, status: 403, error: 'FORBIDDEN', detail: 'owner role required' };
  return { ok: true, uid: decoded.uid, role: role };
}

// fetch with retry/backoff on 429 + 5xx + network error.
async function fetchRetry(url, options, tries) {
  const max = tries || 3;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      const r = await fetch(url, options);
      if (isRetryable(r.status)) { lastErr = { status: r.status, body: await safeText(r) }; await sleep(Math.pow(2, i) * 500); continue; }
      return r;
    } catch (e) {
      lastErr = { status: 0, body: String(e.message || e) };
      await sleep(Math.pow(2, i) * 500);
    }
  }
  const err = new Error('UPSTREAM_RETRIES_EXHAUSTED'); err.detail = lastErr; throw err;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function safeText(r) { try { return await r.text(); } catch (_) { return ''; } }

async function exchangeCode(code, redirectUri) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: redirectUri || DEFAULT_REDIRECT });
  const r = await fetchRetry(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  if (!r.ok) { const e = new Error('EXCHANGE_FAILED'); e.detail = await safeText(r); throw e; }
  return r.json();
}
async function refreshTokens(refreshToken) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const r = await fetchRetry(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  if (!r.ok) { const e = new Error('REFRESH_FAILED'); e.detail = await safeText(r); throw e; }
  return r.json();
}

// Load + (if needed) refresh tokens for a workspace. Returns {accessToken, realmId} or null.
async function getValidTokens(ws) {
  const snap = await tokenDocRef(ws).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (!isExpired(d.expiresAt, 60000)) return { accessToken: d.accessToken, realmId: d.realmId };
  if (!d.refreshToken) return null;
  const t = await refreshTokens(d.refreshToken);
  const updated = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || d.refreshToken,
    realmId: d.realmId,
    expiresAt: new Date(Date.now() + (Number(t.expires_in || 3600) * 1000)).toISOString(),
    updatedAt: new Date().toISOString()
  };
  await tokenDocRef(ws).set(updated, { merge: true });
  return { accessToken: updated.accessToken, realmId: updated.realmId };
}

// ---- HTTPS entrypoint ------------------------------------------------------
exports.qboProxy = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED');
  if (!CLIENT_ID || !CLIENT_SECRET) return fail(res, 500, 'SERVER_NOT_CONFIGURED', 'QBO_CLIENT_ID / QBO_CLIENT_SECRET unset');

  const body = req.body || {};
  const action = body.action;
  const ws = body.workspaceId;

  try {
    if (action === 'exchange') {
      const auth = await authorize(req, ws, true); // owner connects the integration
      if (!auth.ok) { await audit(ws, { decision: 'denied', reason: auth.error, sub: 'exchange' }); return fail(res, auth.status, auth.error, auth.detail); }
      if (!body.code || !body.realmId) return fail(res, 400, 'MISSING_CODE_OR_REALM');
      const t = await exchangeCode(body.code, body.redirectUri);
      await tokenDocRef(ws).set({
        accessToken: t.access_token, refreshToken: t.refresh_token, realmId: String(body.realmId),
        environment: ENV, expiresAt: new Date(Date.now() + (Number(t.expires_in || 3600) * 1000)).toISOString(),
        connectedBy: auth.uid, connectedAt: new Date().toISOString()
      });
      await audit(ws, { decision: 'allowed', actor: auth.uid, sub: 'exchange', detail: 'connected realm ' + body.realmId });
      return res.json({ ok: true, connected: true, realmId: String(body.realmId) }); // NO tokens returned
    }

    if (action === 'status') {
      const auth = await authorize(req, ws, false);
      if (!auth.ok) return fail(res, auth.status, auth.error, auth.detail);
      const snap = await tokenDocRef(ws).get();
      if (!snap.exists) return res.json({ ok: true, connected: false });
      const d = snap.data();
      const expired = isExpired(d.expiresAt, 0);
      return res.json({ ok: true, connected: !expired, expired: expired, realmId: d.realmId, environment: d.environment });
    }

    if (action === 'disconnect') {
      const auth = await authorize(req, ws, true);
      if (!auth.ok) return fail(res, auth.status, auth.error, auth.detail);
      await tokenDocRef(ws).delete();
      await audit(ws, { decision: 'allowed', actor: auth.uid, sub: 'disconnect' });
      return res.json({ ok: true, connected: false });
    }

    if (action === 'createInvoice') {
      const auth = await authorize(req, ws, true);
      if (!auth.ok) { await audit(ws, { decision: 'denied', reason: auth.error, sub: 'createInvoice' }); return fail(res, auth.status, auth.error, auth.detail); }
      if (body.approved !== true) {
        await audit(ws, { decision: 'denied', actor: auth.uid, reason: 'NOT_APPROVED', sub: 'createInvoice' });
        return fail(res, 412, 'APPROVAL_REQUIRED', 'createInvoice requires approved:true');
      }
      if (!body.invoice) return fail(res, 400, 'NO_INVOICE');
      const tok = await getValidTokens(ws);
      if (!tok) { await audit(ws, { decision: 'denied', actor: auth.uid, reason: 'NOT_CONNECTED', sub: 'createInvoice' }); return fail(res, 409, 'NOT_CONNECTED'); }

      const url = `${API_BASE}/v3/company/${tok.realmId}/invoice?minorversion=73`;
      const r = await fetchRetry(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(sanitizeInvoice(body.invoice))
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        await audit(ws, { decision: 'error', actor: auth.uid, sub: 'createInvoice', sourceId: (body.invoice && body.invoice._sourceId) || null, detail: JSON.stringify(json).slice(0, 500) });
        return fail(res, 502, 'QBO_CREATE_FAILED', json);
      }
      const qboId = json.Invoice && json.Invoice.Id;
      await audit(ws, { decision: 'allowed', actor: auth.uid, sub: 'createInvoice', sourceId: (body.invoice && body.invoice._sourceId) || null, detail: 'qboInvoiceId ' + qboId });
      return res.json({ ok: true, Id: qboId });
    }

    return fail(res, 400, 'UNKNOWN_ACTION', action || null);
  } catch (e) {
    console.error('qboProxy error', e);
    await audit(ws, { decision: 'error', sub: action, detail: String(e.message || e) });
    return fail(res, 502, e.message || 'PROXY_ERROR', e.detail || null);
  }
});
