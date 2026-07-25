/*
 * AAA Governance Policy Contract v1 — the ONE versioned policy artifact both
 * repos load. ATLAS/LEVIATHAN STEP 0 (docs/ATLAS_TARGET_ARCHITECTURE.md,
 * Domains 1/4/8 shared prerequisite).
 *
 * The future server Policy Decision Point (PDP) must enforce ONE policy that
 * both HyperKernel and Custonllm already agree on. Today those live as
 * disconnected in-code constants:
 *   - HyperKernel: AAA_RUNTIME_GATEWAY.ACTIONS (action → {permission, aiAllowed})
 *                  + AAA_RBAC.MATRIX (role → permissions[])
 *   - Custonllm:   auth.ROLE_PERMS (role → route-perms) — a DIFFERENT model
 *
 * This module makes them one governed document WITHOUT force-merging two
 * genuinely different permission shapes: `hyperkernel.actionGates` +
 * `hyperkernel.rbac` and `custonllm.routePerms` are separate typed sections
 * under one version. The future PDP dispatches: mutation decisions →
 * actionGates+rbac; route access → routePerms.
 *
 * SOURCE OF TRUTH stays the live in-code constants (exactly like the copilot
 * contract, where copilot-contract.js is truth and the JSON is generated):
 *   - actionGates / rbac are read from the LIVE gateway + RBAC globals here;
 *   - routePerms is a FROZEN MIRROR of Custonllm's ROLE_PERMS — Custonllm's
 *     own conformance test asserts this mirror still equals its live
 *     ROLE_PERMS, so a Python-side change fails CI until this mirror + the
 *     generated artifact are regenerated.
 * schemas/governance-policy-v1.json is GENERATED from document() and a
 * conformance test asserts byte + decision parity. STEP 0 changes NO decision:
 * the gateway still reads its own ACTIONS const; this artifact is a generated,
 * tested projection. Field set is frozen to today's shape — {permission,
 * aiAllowed} only; sensitive/riskTier/category are deferred to an additive
 * v1.1 once a consumer actually reads them (an untested field is drift-bait).
 *
 * HyperKernel is the ONLY writer of the artifact (avoids JS/Python
 * serialization divergence on the cross-repo sha256); Custonllm reads a
 * byte-identical committed copy.
 */
;(function (global) {
  'use strict';

  const VERSION = '1.0';

  // Frozen mirror of Custonllm agent/api/auth.py ROLE_PERMS. Perms are stored
  // SORTED (Python sets are unordered) for a deterministic artifact. The
  // Custonllm conformance test (tests/test_governance_policy.py) asserts this
  // mirror still equals the live ROLE_PERMS — drift there fails CI.
  const CUSTONLLM_ROUTE_PERMS = {
    owner:     ['admin', 'any_model', 'any_persona', 'chat', 'copilot', 'diag', 'manage_keys', 'personas_write', 'tools'],
    admin:     ['admin', 'any_model', 'any_persona', 'chat', 'copilot', 'diag', 'personas_write', 'tools'],
    estimator: ['any_persona', 'chat', 'copilot'],
    crew:      ['any_persona', 'chat', 'copilot'],
    customer:  ['chat']
  };

  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function rbac() { return global.AAA_RBAC; }

  // Deterministic: emit action keys in the gateway's own object order (source
  // order), each as {permission, aiAllowed} exactly — nothing the runtime does
  // not read. Reads the LIVE object's own keys, never a comment or a guess.
  function actionGates() {
    const src = (gateway() && gateway().ACTIONS) || {};
    const out = {};
    Object.keys(src).forEach(function (a) {
      const g = src[a] || {};
      out[a] = { permission: g.permission != null ? g.permission : null, aiAllowed: !!g.aiAllowed };
    });
    return out;
  }

  function rbacSection() {
    const r = rbac() || {};
    const matrix = r.MATRIX || {};
    const roles = {};
    Object.keys(matrix).forEach(function (role) { roles[role] = (matrix[role] || []).slice(); });
    return { permissions: Object.assign({}, r.PERMISSIONS || {}), roles: roles };
  }

  const Policy = {
    VERSION: VERSION,

    /**
     * The full governance policy document — the source for
     * schemas/governance-policy-v1.json. Generated from the live constants;
     * deterministic; pure (no clock, no id, no randomness).
     */
    document: function () {
      return {
        version: VERSION,
        hyperkernel: {
          rbac: rbacSection(),
          actionGates: actionGates()
        },
        custonllm: {
          routePerms: JSON.parse(JSON.stringify(CUSTONLLM_ROUTE_PERMS))
        }
      };
    },

    /** The action-gate for one action (or null) — convenience read. */
    actionGate: function (action) { return actionGates()[action] || null; },

    /** Actions an AI origin may NEVER perform (aiAllowed:false) — the
     *  human-authority set, surfaced for tests + future PDP wiring. */
    humanOnlyActions: function () {
      const g = actionGates();
      return Object.keys(g).filter(function (a) { return g[a].aiAllowed === false; }).sort();
    }
  };

  global.AAA_POLICY = Policy;
})(typeof window !== 'undefined' ? window : this);
