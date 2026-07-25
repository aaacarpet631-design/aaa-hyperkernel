# PDP Deploy Plan — the keystone thin-shell (Firebase Auth + Cloud Functions)

**Status:** decision core BUILT + TESTED (this repo); server shell SPEC + owner-gated deploy.
**Scope:** ATLAS Domain 1 (the keystone). Closes audit criticals **C4** (browser-only
AI-block) and the role/origin half of **C3** (client-asserted tenancy).
**Owner decision already made:** the PDP lives in **Firebase Auth + Cloud Functions**
(behind the shared versioned policy artifact, so it can migrate to a dedicated backend
later with no contract change — ATLAS decision #1).

This document is deliberately deploy-*agnostic on the parts we cannot run here* and
deploy-*specific on the parts we can prove*. The decision brain is fully built and
unit-tested to bit-for-bit fidelity with the live runtime gateway; the Cloud Function
is a thin verified-claims shell around it that only an owner can stand up (it needs a
real Firebase project, service credentials, and a production cutover). Nothing in this
plan fakes that infrastructure or claims it is live.

---

## 1. What is already built and proven (in-repo, testable today)

| Piece | File | Proof |
|---|---|---|
| Shared policy artifact | `js/core/aaa-policy-contract.js` → `schemas/governance-policy-v1.json` | `test/unit/governance-policy.test.js` + custonllm `tests/test_governance_policy.py` (sha256 MANIFEST parity, live-mirror) |
| **PDP decision core** | `js/core/aaa-policy-decision.js` (`AAA_POLICY_DECISION`) | `test/unit/policy-decision.test.js` |
| Golden fidelity | — | `decide()` reproduces the LIVE `AAA_RUNTIME_GATEWAY.ACTIONS` × `AAA_RBAC.MATRIX` verdict for **every** action × origin × role; zero mismatches |
| C4 origin backstop | — | an `agent` principal cannot `FINALIZE_PRICE` even as `owner`; a smuggled `origin:'human'` field is **ignored** (origin is credential-derived) |
| Shadow mode | `shadowCompare(req, clientAllow)` | flags any client verdict that diverges from server truth, blocking nothing |

The core carries **no framework, no I/O, no clock**. That is the point: it is a pure
function of the versioned artifact, so it is unit-tested here to the same fidelity it
will enforce in production, and the Cloud Function adds only credential verification
around it.

**The single load-bearing property:** `decide()` derives `origin` from the
authenticated *principal class* (`originOf(principalType)`), never from a caller-supplied
field. An agent-service credential yields `origin:'ai'` and can never be elevated to
`'human'`, so `aiAllowed:false` actions are categorically closed to agents *on the
server*, where a replaced client cannot bypass them.

---

## 2. The thin shell (Cloud Function) — spec

The Cloud Function does exactly three things beyond `decide()`; all three are
*credential* work, not *policy* work (policy is 100% in the tested core):

```
POST /pdp/authorize        (illustrative shell — owner deploys with real Admin SDK)
──────────────────────────────────────────────────────────────────────────────────
1. VERIFY   idToken = req.header('Authorization').bearer
            claims  = await admin.auth().verifyIdToken(idToken, /*checkRevoked*/ true)
                      // fail-closed: no/invalid/revoked token  -> 401, never a default role

2. RESOLVE  principalType = claims.principalType   // 'human' | 'agent'  (SERVER-SET claim)
            role          = claims.role            // from workspaces/{ws}/members/{uid}
            workspaceId   = claims.workspaceId      // signed claim, NOT req.body
            action        = req.body.action

            // C3: workspaceId comes from the signed claim; a body-asserted
            // workspace_id is ignored. C4: principalType is a claim, not a body field.

3. DECIDE   verdict = AAA_POLICY_DECISION.decide({ action, principalType, role })
            if (!verdict.allow) return 403 { reason: verdict.reason }   // AI_NOT_PERMITTED / FORBIDDEN / ...
            // only past here does the shell relay to the sync store or the model proxy
```

Custom claims (`workspaceId`, `role`, `principalType`) are stamped **server-side** at
sign-in from the authoritative `workspaces/{ws}/members/{uid}` doc that
`firestore.rules` already trusts — the client never sets them. `aaa-firebase.js` already
attaches the Firebase ID token on proxy calls (`authHeaders()` at `callProxy`); today the
server never verifies it. **The highest-leverage move is to verify a token that is
already flowing** — no new client wire format.

The same `aaa-policy-decision.js` module runs in the Cloud Function (it is already an
IIFE that exports `AAA_POLICY_DECISION` on the global; under Node it binds to `this`),
loading the identical `governance-policy-v1.json` artifact both repos share. **One table,
two enforcers** — the browser gateway stays as a fast-fail advisory pre-check for UX; the
PDP is the authority.

---

## 3. Rollout — shadow first, enforce second (never flip cold)

**STEP 1 — SHADOW (block nothing, log divergence).** The shell calls
`AAA_POLICY_DECISION.shadowCompare(req, clientAllow)` instead of gating, where
`clientAllow` is the browser gateway's advisory verdict passed alongside the request. It
records `{match, pdpAllow, clientAllow, reason, action, origin}` for every call and
**relays regardless**. Success criterion before advancing: a burn-in window with **zero
unexplained `match:false`** — every divergence is either a known client bug being fixed
or a real attempted bypass being catalogued. This is the safety valve: it surfaces any
place the client and the artifact-sourced server truth disagree *before* the server can
reject production traffic.

**STEP 2 — ENFORCE.** Flip the shell from `shadowCompare` to `decide` + `403 on
!allow`. Because STEP 1 proved parity, no legitimate request is newly denied; only
bypass attempts (agent tokens on `aiAllowed:false` actions, forged workspace claims,
raw REST calls without a human-principal token) start failing — which is the entire
objective.

**STEP 3 — EXTEND.** Move the audit seal (`aaa-security.sealAudit`) server-side of the
PDP so the chain no longer trusts the client (C6 → per-tenant seal chains), and put every
LLM proxy behind the same shell with per-tenant quota (C2). These ride the same boundary
and are tracked in ATLAS Domain 4 / Domain 8.

Rollback at any step is a one-line shell revert (enforce → shadow → off); the browser
gateway keeps the app fully functional throughout, so no rollout step can brick a client.

---

## 4. What this environment cannot do (stated honestly)

- **No Firebase project / Admin SDK / service credentials** here, so the token-verify and
  claims-stamp steps cannot execute in this repo. They are specified, not run.
- **No production cutover** — advancing STEP 1 → STEP 2 is an owner action on live
  infrastructure with real traffic, not a code merge.
- Therefore this plan ships the **provably-correct half** (the decision core + its
  fidelity/backstop tests) and a **buildable spec** for the half that requires infra the
  owner controls. The core is written so the shell is thin enough to review by eye.

---

## 5. Definition of done for the keystone

- [x] PDP decision core built, pure, artifact-sourced (`aaa-policy-decision.js`).
- [x] Golden-fidelity test: `decide()` == live gateway for all action × origin × role.
- [x] C4 origin backstop proven un-spoofable (derived from principal class).
- [x] `shadowCompare()` for STEP-1 rollout.
- [x] Wired into `index.html`, `sw.js`, `test/run.js`; full suite + lint green.
- [ ] *(owner)* Cloud Function shell deployed; server-set custom claims at sign-in.
- [ ] *(owner)* STEP-1 shadow burn-in → STEP-2 enforce cutover.

Items marked *(owner)* require live Firebase infrastructure and a production decision;
they are out of scope for this repo and must not be simulated.
