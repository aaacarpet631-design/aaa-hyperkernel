/*
 * pdpAuthorize — the Policy Decision Point's thin verified-claims shell
 * (ATLAS Domain 1 keystone; see docs/PDP_DEPLOY_PLAN.md).
 *
 * All policy lives in the byte-parity copy of the canonical decision core
 * (aaa-policy-decision.js) driven by the shared governance artifact; this file
 * adds ONLY credential work:
 *   1. VERIFY  — Firebase ID token, revocation-checked. No/invalid token =>
 *                401, never a default role (fail closed).
 *   2. RESOLVE — principalType / role / workspaceId come from SERVER-SET
 *                custom claims stamped at sign-in from
 *                workspaces/{ws}/members/{uid}. Body-asserted identity fields
 *                are ignored (C3/C4).
 *   3. DECIDE  — lib.handleAuthorize() -> the canonical decide()/shadowCompare().
 *
 * Rollout mode comes from the PDP_MODE env var: 'shadow' (default — compare +
 * log, block nothing; STEP 1) or 'enforce' (403 on deny; STEP 2). Shadow
 * divergences are logged so the burn-in criterion (zero unexplained
 * match:false) is observable in Cloud Logging.
 *
 * Deploy:  firebase deploy --only functions:pdpAuthorize   (owner-gated)
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const lib = require('./lib');

try { admin.initializeApp(); } catch (_) { /* already initialized alongside sibling functions */ }

const ALLOWED_ORIGIN = process.env.PDP_ALLOWED_ORIGIN || '*';

exports.pdpAuthorize = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });

  // 1. VERIFY — fail closed. checkRevoked:true so an owner kill is immediate.
  let claims = null;
  const auth = req.get('Authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken, true);
      // 2. RESOLVE — server-set custom claims only. Nothing from the body.
      claims = { principalType: decoded.principalType, role: decoded.role, workspaceId: decoded.workspaceId };
    } catch (_) {
      claims = null; // invalid/expired/revoked => UNAUTHENTICATED below
    }
  }

  // 3. DECIDE — pure, artifact-driven, integrity-checked (throws => 500, closed).
  try {
    const out = lib.handleAuthorize({ claims: claims, body: req.body || {}, mode: process.env.PDP_MODE });
    if (out.json && out.json.mode === 'shadow' && out.json.shadow && out.json.shadow.match === false) {
      // The STEP-1 burn-in signal: client verdict diverged from server truth.
      console.warn('PDP_SHADOW_DIVERGENCE', JSON.stringify(out.json.shadow));
    }
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error('pdpAuthorize error', e);
    return res.status(500).json({ ok: false, error: 'PDP_UNAVAILABLE' }); // never fail open
  }
});
