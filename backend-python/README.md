# AAA Backup Backend — Python (Cloud Functions gen2)

Faithful port of the Node backend. Same endpoints, auth, bucket layout, and JSON
shapes — the frontend config does not change at all.

## Files
- main.py          — the function (pure testable core + GCS adapter)
- requirements.txt — functions-framework, google-cloud-storage
- test_main.py     — 19 stdlib unit tests (run: python3 -m unittest test_main -v)

## Environment variables
All configuration is via environment variables (set at deploy time with
`--set-env-vars`). No secrets live in code or in the browser.

| Var              | Required | Purpose / expectations |
|------------------|----------|------------------------|
| `APP_TOKEN`      | **yes**  | Shared owner secret. The browser sends it as the `x-app-token` header; the function compares it with constant intent and rejects on any mismatch. Use a long (32+ char) random value. If unset, **every** request is rejected (fail-closed) — the function never runs open. Rotate by redeploying with a new value and updating the frontend config. |
| `BACKUP_BUCKET`  | **yes**  | Name of the GCS bucket that holds backups. If unset, all authed requests return `500 BACKUP_BUCKET_NOT_SET` (no guessing a default bucket). The function's **service account** must have object read/write on this bucket — no Google API key is exposed to the browser. |
| `ALLOWED_ORIGIN` | no       | Value echoed in `Access-Control-Allow-Origin`. Set it to the exact frontend origin (e.g. `https://seiro-a54915.netlify.app`). Defaults to `*` if unset — set it explicitly in production. |

Project/region are deploy flags (`--region`, the active `gcloud` project), not
runtime env vars. The bucket must already exist in that project.

## Threat model
Scope: a single owner-only HTTP function that versions JSON backups to one
private GCS bucket. Not multi-tenant; there is exactly one trusted caller.

- **Auth expectations.** Owner-only via the shared `APP_TOKEN` secret sent as
  `x-app-token`. Auth is checked **before any routing or storage access**, so an
  unauthenticated/forged request can never reach a read or a write (a regression
  guard test asserts unauthorized requests perform zero writes). Missing server
  `APP_TOKEN` ⇒ reject everything (fail-closed). `OPTIONS` preflight is the only
  unauthenticated path and it touches no storage. There is no rate limiting or
  per-request signing — the token is the whole trust boundary, so treat it like
  a password: long, random, rotated, never logged.
- **Overwrite protection.** Versioned objects are named `backups/backup-<ms>.json`
  using a millisecond epoch version, and a separate `backups/latest.json` pointer
  is updated each write. Prior versions are never deleted and, because each write
  gets a new timestamped name, never overwritten — restore-preview always reads
  the newest via the pointer while history is retained. (Caveat: two writes in the
  same millisecond would collide on one name; backups are owner-initiated and not
  concurrent, so this is acceptable. Enabling **object versioning** on the bucket
  is the belt-and-suspenders defense and is recommended.)
- **Storage failure behavior.** Any storage error is caught and returned as
  `500 {"ok": false, "error": "SERVER_ERROR", "detail": <message>}`. `detail`
  carries the exception *message* only — never a stack trace, file path, or line
  number (a test asserts no traceback artifacts leak). A failed backup write
  leaves the previous `latest.json` pointer intact, so a partial failure never
  advances the pointer to a missing object.
- **What data should NOT be stored.** The `payload` is opaque to the backend and
  stored verbatim, so the **client decides** what goes in. Do not place secrets
  in a backup: no passwords, API keys, OAuth/refresh tokens, full payment-card
  numbers, or government IDs. Keep backups to operational business data (jobs,
  quotes, customers, schedules). Anything sensitive should be redacted or
  encrypted client-side before it is sent. The bucket must stay **private**
  (no public/allUsers access) and ideally have a retention/lifecycle policy.

## Deploy (from this folder)
gcloud functions deploy aaa-backup-service \
  --gen2 --runtime=python312 --region=us-central1 \
  --source=. --entry-point=aaa_backup \
  --trigger-http --allow-unauthenticated \
  --set-env-vars=APP_TOKEN=YOUR-NEW-LONG-RANDOM-SECRET,BACKUP_BUCKET=YOUR-BUCKET-NAME,ALLOWED_ORIGIN=https://seiro-a54915.netlify.app

NOTE: entry point is aaa_backup (snake_case), unlike the Node aaaBackup.
Deploying with the same function name (aaa-backup-service) REPLACES the Node
version — same URL, so the frontend needs no endpoint change.

## Verify after deploy
curl -H "x-app-token: YOUR-NEW-TOKEN" \
  https://us-central1-YOURPROJECT.cloudfunctions.net/aaa-backup-service/backup/latest
# expect: {"ok":true,"info":null}   (or info about your latest backup)

## What was tested vs not
- TESTED here (19 tests): auth (missing/wrong/case-insensitive token, no server
  token, missing bucket), backup write + versioned object + latest pointer,
  latest with/without backups, restore preview round-trip, second backup updates
  pointer without overwriting v1, trailing slashes, unknown routes, storage
  exceptions -> SERVER_ERROR. Hardening: unauthorized requests (missing / wrong /
  no-server token) perform **zero reads and zero writes** to storage, and storage
  exceptions never leak a stack trace (message only).
- NOT tested here (verify with curl after deploy): real GCS writes and the
  Flask/functions-framework HTTP layer. The logic those layers call is the
  tested part.
