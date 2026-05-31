# AAA Customer Portal Proxy (`portalProxy`)

Public, token-authenticated Cloud Function that powers `portal.html` — the page
a customer opens (no login) to view their quote/contract, sign it, and see the
invoice balance.

## Security model
- The **unguessable token** in the share link is the only credential. It maps to
  one contract in one workspace (`workspaces/{ws}/portal_links/{token}`).
- **Expiry + revocation** are checked server-side on every request.
- The response is built by **whitelist** (`lib.publicContract` / `publicInvoice`),
  so internal financials (labor/material cost, margins, internal notes) never
  leave the server even though the Admin SDK can read everything.
- The only mutation is the **customer signing their own contract** (additive; a
  signed/void contract can't be re-signed).
- Every `view` and `sign` writes an **append-only audit_log** entry (origin
  `portal`). No destructive operations are exposed.

## Actions (POST JSON; no auth header — the token authenticates)
| action | body | effect |
|---|---|---|
| `view` | `{token}` | redacted contract + invoice balance + `canSign` |
| `sign` | `{token, name, signatureDataUrl}` | record signature, return updated view |

Responses are `{ok:true,...}` or `{ok:false, error}` (e.g. `INVALID_LINK`,
`LINK_INACTIVE`, `ALREADY_SIGNED`, `NAME_REQUIRED`).

## Required environment variables
| var | required | example |
|---|---|---|
| `PORTAL_ALLOWED_ORIGIN` | recommended | `https://your-app` (CORS; defaults `*`) |

No secrets are required — the token model needs none.

## Firestore index
The function looks up a token across workspaces with a **collection-group** query
on `portal_links` (`where id == token`). Add a single-field collection-group
index for `portal_links.id` (Firebase prompts with a one-click link on first
run, or add it to `firestore.indexes.json`).

## Deploy
```bash
cd functions/portal-proxy && npm install
firebase deploy --only functions:portalProxy \
  --set-env-vars PORTAL_ALLOWED_ORIGIN=https://your-app
```
Then put the deployed function URL into **`portal.html`** (replace
`__PORTAL_PROXY_URL__`). The owner app builds share links from `portalBaseUrl`
(or the current origin) → `/portal.html?t=<token>`.

## Test
```bash
cd functions/portal-proxy && npm test   # 24 offline unit tests (redaction + lifecycle)
```

## Live now vs. needs setup
- **Live now:** the full function + whitelist redaction + audit + sign flow, the
  owner "Share" UI, the public page, and all unit tests.
- **Needs setup to run end-to-end:** Firestore configured (the app writing
  `portal_links` + contracts to the cloud), the function deployed, and the
  `__PORTAL_PROXY_URL__` placeholder in `portal.html` replaced with its URL.
