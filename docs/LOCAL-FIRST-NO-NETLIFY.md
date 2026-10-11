# HyperKernel: Continue Without Netlify

## Objective

Keep improving and testing AAA HyperKernel without requiring a Netlify subscription. This is a development and architecture plan, not a claim that the production app has been redeployed.

## Current repository facts

- The application is a JavaScript, local-first field PWA.
- The repository has a Node-based test suite, ESLint, a GitHub Actions workflow, Firebase/Firestore setup material, Supabase setup material, and cloud-mirroring integrations.
- The current CI workflow includes a Netlify offline build check. An offline build check does not require a paid production deployment, but it does require the relevant CLI/dependencies in CI.
- The quote-builder audit identifies browser/device verification, cross-tab/device write conflicts, and durable cloud backup as remaining release gates.
- No Netlify subscription or production deployment is assumed by this plan.

## Operating mode while Netlify is unavailable

1. **Keep source of truth in GitHub.** Make focused changes on branches, preserve reviewable commits, and never claim a live app changed just because repository code changed.
2. **Run checks locally or in GitHub Actions.** Use Node 20 and the repository's existing scripts:
   - `npm test`
   - `npm run lint` (install development dependencies first)
   - `npm run test:rules` when the Firestore emulator dependencies are available.
3. **Keep the PWA local-first.** A user should be able to draft and revise quotes without waiting for a network request. Clearly distinguish locally saved, sync pending, and synced states.
4. **Do not silently imply cloud backup.** Local browser storage is not a backup and may be cleared by the browser/device. Show an explicit export/backup path and communicate whether a quote is only on this device.
5. **Make cloud services optional adapters.** Quote calculation and the core workflow must not require Netlify Blobs. Treat each remote provider as an adapter behind a stable interface, with timeouts, retries, observable sync status, and no loss of local work when a provider is unavailable.
6. **Keep secrets out of the browser.** API keys and privileged database credentials must never be embedded in static JavaScript. Any cloud model or database integration must use appropriate server-side credentials and access rules.

## Recommended next implementation sequence

### P0 — protect quote data

- Add/verify a visible local save state and a last-saved timestamp.
- Add quote export/import with schema versioning and validation.
- Preserve unfinished quote drafts independently; never overwrite one draft with another.
- Add regression tests for storage failures, malformed imports, duplicate quote IDs, and interrupted sync.

### P1 — make sync resilient

- Define a provider-neutral sync adapter contract.
- Store an outbox of pending changes locally, with stable operation IDs and retry metadata.
- Use idempotent writes and revision/conflict checks; never resolve conflicts by silently overwriting newer customer data.
- Expose per-record states: Local only, Pending sync, Synced, Conflict, and Sync failed.
- Do not mark data Synced until the provider confirms durable acceptance.

### P2 — deployment choices without a paid Netlify plan

- **Local development/PWA:** continue using the repository and test suite; no public hosting required.
- **Static preview:** GitHub Pages can host eligible static assets, but it cannot run the existing Netlify Functions or provide private server-side secrets by itself.
- **Backend:** use an already-configured Firebase or Supabase project only after verifying credentials, rules, quotas, and data ownership. Do not migrate customer data merely to avoid one hosting bill.
- **AI:** keep model access disabled or clearly unavailable when no secured backend/provider credentials exist. Never fake an agent action or return sample data as a real result.

## Release gates

Do not call the app production-ready until all applicable items are verified:

- Quote create/edit/reopen/approve/cancel/share/print works on a real phone.
- The app clearly communicates local-only versus synced data.
- Export and restore work on a second browser/device.
- Cross-tab and cross-device conflicts are tested.
- Security rules prevent one workspace from reading or writing another workspace's records.
- AI/model calls fail safely when unavailable, and never expose provider secrets.
- CI passes and the exact release commit is identified.
- A deployment URL is only reported after an actual deployment is verified.

## Immediate next action

Inspect the current quote store, local persistence layer, and service worker; identify the smallest safe improvement that increases recoverability without adding a required paid service. Make that change separately with regression tests and a reviewable diff.
