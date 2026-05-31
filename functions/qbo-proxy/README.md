# AAA QuickBooks Online Proxy (`qboProxy`)

Server-side proxy that holds the QuickBooks client secret and OAuth tokens so
the browser never sees them. It is the live counterpart to the client-side
CSV export.

## Why a proxy
QuickBooks OAuth2 requires a **client secret** to exchange/refresh tokens. That
secret cannot live in a PWA. This Cloud Function:

- exchanges the OAuth `code` for tokens **server-side** and stores them in
  Firestore at `workspaces/{ws}/integrations/qbo` (never returned to the client),
- verifies the caller's **Firebase ID token** and **workspace membership**,
  requiring `role: owner` for the connect/disconnect/createInvoice actions,
- writes an **append-only audit_log** entry for every attempt,
- **retries** transient QBO errors (429/5xx) with backoff,
- only ever **creates** invoices (additive) and only when the caller passes
  `approved: true` — it never updates, voids, or deletes anything.

## Actions (POST JSON, `Authorization: Bearer <firebase id token>`)
| action | role | effect |
|---|---|---|
| `exchange` | owner | `{code, realmId, redirectUri}` → store tokens for workspace |
| `status` | member | `{}` → `{connected, expired, realmId}` (no tokens) |
| `disconnect` | owner | delete stored tokens |
| `createInvoice` | owner | `{invoice, approved:true}` → create invoice in QBO |

All requests include `workspaceId`. All responses are `{ok:true,...}` or
`{ok:false, error, detail}`.

## Required environment variables
Set on the function (see deploy below):

| var | required | example |
|---|---|---|
| `QBO_CLIENT_ID` | yes | `ABwd...` (Intuit app key) |
| `QBO_CLIENT_SECRET` | yes | `9f2...` (Intuit app secret — **server only**) |
| `QBO_ENVIRONMENT` | yes | `sandbox` or `production` |
| `QBO_REDIRECT_URI` | yes | `https://your-app/qbo-callback` (must match the Intuit app) |
| `QBO_ALLOWED_ORIGIN` | recommended | `https://your-app` (CORS; defaults to `*`) |

## Deploy
```bash
cd functions/qbo-proxy
npm install

# 1) create an Intuit app at https://developer.intuit.com → get keys + set the
#    redirect URI to your QBO_REDIRECT_URI.

# 2) set env vars (Firebase Functions gen-2 / Cloud Run style)
firebase functions:secrets:set QBO_CLIENT_SECRET        # paste secret
firebase deploy --only functions:qboProxy \
  --set-env-vars QBO_CLIENT_ID=...,QBO_ENVIRONMENT=sandbox,QBO_REDIRECT_URI=...,QBO_ALLOWED_ORIGIN=https://your-app

# (or use the Cloud Console to set env vars on the function)
```
Then set the **client** config (per device or workspace):
`AAA_CONFIG.set({ qboClientId, qboRedirectUri, qboEnvironment, qboProxyUrl })`
where `qboProxyUrl` is the deployed function URL. `qboClientId` and
`qboRedirectUri` are public; **no secret goes in the client**.

## Firestore rules
Add a deny for the token store so clients can never read it (Admin SDK in the
function bypasses rules):
```
match /workspaces/{ws}/integrations/{doc} { allow read, write: if false; }
```
(Included in this repo's `firestore.rules`.)

## Test
```bash
cd functions/qbo-proxy
npm test     # offline unit tests for sanitizeInvoice / isExpired / apiBase / isRetryable
```
The HTTP handler itself is integration-tested against the Intuit **sandbox**
once real credentials are set (see "needs credentials" below).

## What is live vs. needs Intuit credentials
**Live now (no credentials):**
- Full proxy code, auth/membership/role checks, token storage design, audit
  logging, retry/backoff, approval gate, and the pure-logic unit tests.
- Client CSV export (separate, needs nothing).

**Needs real Intuit credentials to run end-to-end:**
- An Intuit developer app (client id/secret) and the redirect URI registered.
- The four env vars set on the deployed function.
- Then the connect flow and `createInvoice` work against the QBO sandbox/prod.
