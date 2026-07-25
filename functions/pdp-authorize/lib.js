/*
 * Pure, dependency-free core of the PDP Cloud Function shell — unit-testable
 * without firebase-admin or network (see docs/PDP_DEPLOY_PLAN.md).
 *
 * This directory carries BYTE-IDENTICAL committed copies of the canonical
 * decision core (js/core/aaa-policy-decision.js) and the shared governance
 * artifact (schemas/governance-policy-v1.json) because Firebase deploys only
 * the functions/ tree. test.js asserts byte parity against the canonical
 * files, and createPdp() verifies the artifact's sha256 against the MANIFEST
 * at load — a corrupted or drifted policy FAILS CLOSED (throws) rather than
 * serving permissive defaults.
 *
 * Security invariants (the ones the browser cannot provide):
 *  - action comes from the request body, but principalType / role /
 *    workspaceId come ONLY from server-verified token claims. Any of those
 *    fields appearing in the body are ignored.
 *  - Missing/incomplete claims => deny (MISSING_CLAIMS). There is no default
 *    role — the fail-open trap the audit flagged in custonllm auth.
 *  - origin is derived inside the decision core from principalType
 *    ('agent' => 'ai'), so aiAllowed:false actions are categorically closed
 *    to agent credentials (audit critical C4).
 *  - shadow mode never blocks; it reports the PDP-vs-client comparison so
 *    divergence is logged during rollout (STEP 1) before enforcement (STEP 2).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ARTIFACT_PATH = path.join(__dirname, 'contracts', 'governance-policy-v1.json');
const MANIFEST_PATH = path.join(__dirname, 'contracts', 'governance-policy.MANIFEST.json');
const CORE_PATH = path.join(__dirname, 'aaa-policy-decision.js');

// Verify the bundled artifact against its MANIFEST sha256. Returns the parsed
// artifact or throws — the caller must not fall back to any default policy.
function loadVerifiedArtifact() {
  const bytes = fs.readFileSync(ARTIFACT_PATH);
  const want = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))['governance-policy-v1.json'];
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error('POLICY_ARTIFACT_INTEGRITY_FAILURE: sha256 ' + got + ' != manifest ' + want);
  return JSON.parse(bytes.toString('utf8'));
}

// Load the canonical decision core (the exact browser module, unmodified) in
// an isolated context, fed by the verified artifact instead of live modules.
let _pdp = null;
function createPdp() {
  if (_pdp) return _pdp;
  const artifact = loadVerifiedArtifact();
  const g = { AAA_POLICY: { document: function () { return artifact; } } };
  vm.runInNewContext(fs.readFileSync(CORE_PATH, 'utf8'), { window: g });
  if (!g.AAA_POLICY_DECISION || typeof g.AAA_POLICY_DECISION.decide !== 'function') {
    throw new Error('PDP_CORE_LOAD_FAILURE');
  }
  _pdp = g.AAA_POLICY_DECISION;
  return _pdp;
}

/**
 * The pure request handler. index.js verifies the Firebase ID token and passes
 * the resulting claims here; tests inject claims directly.
 * @param {Object} opts { claims, body, mode:'shadow'|'enforce' }
 *   claims — SERVER-VERIFIED token claims ({ principalType, role, workspaceId })
 *            or null when verification failed / no token.
 *   body   — client request body; only `action` (and `clientAllow` in shadow
 *            mode) are read from it. principalType/role/workspaceId/origin in
 *            the body are IGNORED.
 * @returns {Object} { status, json } — never throws on bad input.
 */
function handleAuthorize(opts) {
  const o = opts || {};
  const claims = o.claims || null;
  const body = o.body || {};
  const mode = o.mode === 'enforce' ? 'enforce' : 'shadow'; // default: shadow (STEP 1)

  // Fail closed: no verified identity, no decision. Never a default role.
  if (!claims) return { status: 401, json: { ok: false, error: 'UNAUTHENTICATED' } };
  if (!claims.principalType || !claims.role || !claims.workspaceId) {
    return { status: 403, json: { ok: false, error: 'MISSING_CLAIMS' } };
  }

  const action = typeof body.action === 'string' ? body.action : null;
  if (!action) return { status: 400, json: { ok: false, error: 'NO_ACTION' } };

  // Claims-only inputs — a body-supplied principalType/role/origin never reaches decide().
  const req = { action: action, principalType: claims.principalType, role: claims.role };
  const pdp = createPdp();

  if (mode === 'shadow') {
    const cmp = pdp.shadowCompare(req, body.clientAllow === true);
    // Shadow blocks nothing; it returns the comparison for logging. `match:false`
    // is the rollout signal that must reach zero before flipping to enforce.
    return { status: 200, json: { ok: true, mode: 'shadow', enforced: false, shadow: cmp, workspaceId: claims.workspaceId } };
  }

  const verdict = pdp.decide(req);
  if (!verdict.allow) {
    return { status: 403, json: { ok: false, error: verdict.reason, mode: 'enforce', decision: verdict, workspaceId: claims.workspaceId } };
  }
  return { status: 200, json: { ok: true, mode: 'enforce', decision: verdict, workspaceId: claims.workspaceId } };
}

module.exports = { loadVerifiedArtifact: loadVerifiedArtifact, createPdp: createPdp, handleAuthorize: handleAuthorize, ARTIFACT_PATH: ARTIFACT_PATH, MANIFEST_PATH: MANIFEST_PATH, CORE_PATH: CORE_PATH };
