/*
 * AAA Policy Decision Point (PDP) — the deploy-agnostic decision core of the
 * server trust boundary. ATLAS Phase 2 Domain 1 / keystone (Firebase Auth +
 * Cloud Functions). Resolves audit criticals C4 (browser-only AI-block) and
 * the role half of C3.
 *
 * decide({action, principalType, role}) is a PURE function of the SHARED
 * governance-policy artifact (AAA_POLICY, the STEP-0 contract): it reproduces
 * exactly what the runtime gateway decides, but from the versioned policy both
 * repos load — so the SAME decision can be enforced server-side where a
 * hostile client cannot bypass it.
 *
 * THE ORIGIN BACKSTOP (the whole point of C4): origin is derived from the
 * authenticated PRINCIPAL CLASS, never from a client-supplied field. A
 * 'human' session credential yields origin 'human'; an 'agent' service
 * credential yields origin 'ai' and can NEVER be elevated to human — so
 * aiAllowed:false actions are categorically closed to agents server-side, and
 * the browser gateway's aiAllowed:false becomes a fast-fail advisory
 * pre-check. There is no `origin` input a caller can spoof.
 *
 * Deployment: a Cloud Function verifies the Firebase ID token, reads
 * workspaceId + principalType + role from server-set custom claims, and calls
 * decide(); this module carries no framework, no I/O, no clock — so it is unit
 * -tested to bit-for-bit fidelity with the live gateway here, and the Cloud
 * Function is a thin verified-claims shell around it. STEP 1 runs it in SHADOW
 * mode (compare + log, block nothing) before enforcing — see shadowCompare().
 */
;(function (global) {
  'use strict';

  function policy() { return global.AAA_POLICY; }

  // The two principal classes. Origin is a property of the credential, full
  // stop. 'agent' can never be mapped to a human origin.
  function originOf(principalType) { return principalType === 'agent' ? 'ai' : 'human'; }

  function gates() {
    const p = policy();
    const doc = p && p.document ? p.document() : null;
    return (doc && doc.hyperkernel && doc.hyperkernel.actionGates) || {};
  }
  function rolePerms(role) {
    const p = policy();
    const doc = p && p.document ? p.document() : null;
    const roles = (doc && doc.hyperkernel && doc.hyperkernel.rbac && doc.hyperkernel.rbac.roles) || {};
    return roles[role] || null; // null = unknown role
  }

  const PDP = {
    originOf: originOf,

    /**
     * The authoritative decision for an action attempt. Pure; reads only the
     * shared policy artifact.
     * @param {Object} req { action, principalType:'human'|'agent', role }
     * @returns {Object} { allow, decision:'allow'|'deny', reason, action,
     *                     origin, requiredPermission }
     */
    decide: function (req) {
      const r = req || {};
      const action = r.action;
      const origin = originOf(r.principalType); // derived, never asserted
      const role = r.role;
      const base = { action: action, origin: origin, requiredPermission: null };

      const gate = gates()[action];
      if (!gate) return Object.assign({ allow: false, decision: 'deny', reason: 'UNKNOWN_ACTION' }, base);
      base.requiredPermission = gate.permission || null;

      // 1) Origin backstop — a code-constant, artifact-sourced: an AI/agent
      // principal can never perform a human-only action, whatever its role.
      if (origin === 'ai' && gate.aiAllowed !== true) {
        return Object.assign({ allow: false, decision: 'deny', reason: 'AI_NOT_PERMITTED' }, base);
      }
      // 2) RBAC — the role must hold the required permission (if any).
      if (gate.permission) {
        const perms = rolePerms(role);
        if (perms == null) return Object.assign({ allow: false, decision: 'deny', reason: 'UNKNOWN_ROLE' }, base);
        if (perms.indexOf(gate.permission) === -1) return Object.assign({ allow: false, decision: 'deny', reason: 'FORBIDDEN' }, base);
      }
      return Object.assign({ allow: true, decision: 'allow', reason: 'OK' }, base);
    },

    /**
     * SHADOW MODE: compare the PDP's authoritative decision against a client's
     * (advisory) verdict without blocking. Returns { match, pdp, client } so a
     * Cloud Function can LOG divergences during rollout before enforcing.
     * A mismatch means the client verdict disagrees with the server truth —
     * exactly what must be surfaced before flipping to enforcement.
     */
    shadowCompare: function (req, clientAllow) {
      const pdp = this.decide(req);
      return { match: pdp.allow === !!clientAllow, pdpAllow: pdp.allow, clientAllow: !!clientAllow, reason: pdp.reason, action: pdp.action, origin: pdp.origin };
    }
  };

  global.AAA_POLICY_DECISION = PDP;
})(typeof window !== 'undefined' ? window : this);
