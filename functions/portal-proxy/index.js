/*
 * AAA Portal Proxy — public, token-authenticated customer view.
 *
 * Lets a customer (no login) open a share link to view their quote/contract,
 * sign it, and see the invoice balance. Security model:
 *  - The unguessable token IS the credential; it maps to ONE contract in ONE
 *    workspace (workspaces/{ws}/portal_links/{token}). No token => no data.
 *  - Revocation + expiry are enforced server-side on every call.
 *  - The response is built by WHITELIST (see lib.publicContract/Invoice), so
 *    internal financials (labor/material cost, margins, notes) never leave the
 *    server, even though the Admin SDK can read everything.
 *  - The only mutation is the customer signing their OWN contract (additive;
 *    a signed/void contract can't be re-signed). Every view/sign is written to
 *    the append-only audit_log with origin 'portal'.
 *  - No destructive operations are exposed.
 *
 * Deploy as the HTTPS function `portalProxy`; serve portal.html from hosting.
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { linkLive, buildView } = require('./lib');
admin.initializeApp();
const db = admin.firestore();

const ALLOWED_ORIGIN = process.env.PORTAL_ALLOWED_ORIGIN || '*';

function fail(res, status, error, detail) {
  return res.status(status).json({ ok: false, error: error, detail: detail || null });
}

async function audit(ws, entry) {
  if (!ws) return;
  try {
    const ref = db.collection(`workspaces/${ws}/audit_log`).doc();
    await ref.set(Object.assign({ id: ref.id, at: new Date().toISOString(), action: 'PORTAL', origin: 'portal', source: 'portal-proxy' }, entry));
  } catch (e) { console.error('audit failed', e); }
}

// Find a portal link across workspaces by token. We use a collectionGroup query
// so the public caller never needs to supply (or know) the workspace id.
async function findLink(token) {
  if (!token) return null;
  const snap = await db.collectionGroup('portal_links').where('id', '==', token).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  // path: workspaces/{ws}/portal_links/{token}
  const ws = doc.ref.path.split('/')[1];
  return { ws: ws, link: doc.data() };
}

async function loadContract(ws, id) {
  const s = await db.doc(`workspaces/${ws}/contracts/${id}`).get();
  return s.exists ? s.data() : null;
}
async function loadInvoiceForJob(ws, jobId) {
  if (!jobId) return { invoice: null, paid: 0 };
  const invSnap = await db.collection(`workspaces/${ws}/invoices`).where('jobId', '==', jobId).limit(1).get();
  if (invSnap.empty) return { invoice: null, paid: 0 };
  const invoice = invSnap.docs[0].data();
  const paySnap = await db.collection(`workspaces/${ws}/payments`).where('jobId', '==', jobId).get();
  let paid = 0; paySnap.forEach((p) => { paid += Number((p.data() || {}).amount || 0); });
  return { invoice: invoice, paid: paid };
}
async function businessName(ws) {
  try { const s = await db.doc(`workspaces/${ws}`).get(); return (s.exists && s.data() && s.data().businessName) || 'AAA Carpet'; }
  catch (_) { return 'AAA Carpet'; }
}

exports.portalProxy = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED');

  const body = req.body || {};
  const action = body.action;
  const token = body.token;

  try {
    const found = await findLink(token);
    if (!found) return fail(res, 404, 'INVALID_LINK');
    const ws = found.ws, link = found.link;
    if (!linkLive(link, Date.now())) { await audit(ws, { decision: 'denied', reason: 'LINK_EXPIRED_OR_REVOKED', sub: action }); return fail(res, 410, 'LINK_INACTIVE'); }

    const contract = await loadContract(ws, link.contractId);
    if (!contract) return fail(res, 404, 'CONTRACT_NOT_FOUND');

    if (action === 'view') {
      const inv = await loadInvoiceForJob(ws, link.jobId);
      await audit(ws, { decision: 'allowed', sub: 'view', contractId: link.contractId });
      return res.json(buildView({ businessName: await businessName(ws), contract: contract, link: link, invoice: inv.invoice, paidAmount: inv.paid }));
    }

    if (action === 'sign') {
      if (!link.allowSign) return fail(res, 403, 'SIGNING_DISABLED');
      if (contract.status === 'signed') return fail(res, 409, 'ALREADY_SIGNED');
      if (contract.status === 'void') return fail(res, 409, 'VOID');
      const name = String(body.name || '').trim();
      if (!name) return fail(res, 400, 'NAME_REQUIRED');
      const signature = { name: name, dataUrl: typeof body.signatureDataUrl === 'string' ? body.signatureDataUrl.slice(0, 250000) : null, signedAt: new Date().toISOString(), via: 'portal' };
      await db.doc(`workspaces/${ws}/contracts/${link.contractId}`).set({ status: 'signed', signature: signature, updatedAt: signature.signedAt }, { merge: true });
      await audit(ws, { decision: 'allowed', sub: 'sign', contractId: link.contractId, detail: 'signed by ' + name + ' via portal' });
      const updated = await loadContract(ws, link.contractId);
      const inv = await loadInvoiceForJob(ws, link.jobId);
      return res.json(buildView({ businessName: await businessName(ws), contract: updated, link: link, invoice: inv.invoice, paidAmount: inv.paid }));
    }

    return fail(res, 400, 'UNKNOWN_ACTION', action || null);
  } catch (e) {
    console.error('portalProxy error', e);
    return fail(res, 502, e.message || 'PROXY_ERROR');
  }
});
