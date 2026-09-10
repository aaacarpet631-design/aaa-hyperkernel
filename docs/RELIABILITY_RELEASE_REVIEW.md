# Reliability and daily workflow review — September 10, 2026

Engineering assessment: **8/10 for the reviewed quote and recovery workflow**, provisionally, after this pass. The earlier connected-builder review was 7.5/10. These are judgments, not usability-study scores, and are not a rating of every HyperKernel module. A 10/10 claim would be unsupported without physical-device, live-service and broader accessibility evidence.

## What changed

| Observed problem | Implemented correction |
| --- | --- |
| Separate tabs cached and rewrote entire collections; checks above storage could race. | Fresh durable reads, exclusive Web Locks, storage-level expected revisions, immutable read copies, cross-tab change notifications and preservation of unrelated writes after a temporary storage failure. |
| An editor could close despite an unsaved working form, or reuse a form another tab owned. | Close waits for durable form persistence; each active form holds a tab lock. A second tab receives an independent working copy. New forms acquire their own lock. |
| Conflicts offered wholesale replacement or a new quote. | A three-way comparison of the original input, local draft and latest saved input. Disjoint edits combine; conflicting fields require choices. Service arrays are resolved together to avoid pairing unrelated rooms by index. The original working form remains recoverable. Recalculation, saving and new human approval remain separate steps. |
| Cloud synchronization merged unverified callers into one global state and could acknowledge a stale queue. | Identity-provider verification plus server allowlists; account/workspace/device-scoped snapshots; conditional generation writes; acknowledgement of exactly the uploaded mutation IDs; durable records act as the backup outbox after reload. |
| Backup success was unclear and restoring could replace existing records. | Visible state, confirmed timestamp, retry/offline explanations, checksummed exports, read-only restore previews and add-missing recovery. Existing records survive; the verified incoming copy is archived before restoration. Previous confirmed cloud generations are preserved before replacing the latest snapshot. |
| Paid provider and storage functions were accessible without app authorization. | Shared authentication and request bounds, a distributed 60-request/minute account budget using conditional Blobs writes, model request/token limits, bounded provider timeouts and protected receipt keys. OpenAI retains its separate allowlist. |
| Delivery callbacks could accept forged events and acknowledge persistence failures. | Twilio and SendGrid signatures, bounded bodies, deterministic callback deduplication and failed writes return an error so the provider can retry. The sensing shared secret is mandatory. |
| Useful business tools were buried behind large administrative screens. | A searchable, permission-filtered tool directory in More; direct quote, saved-quote and scheduling shortcuts on the home screen; saved-customer reuse in the builder; search within quote views. |
| “Today's Jobs” showed undated/other-day work and the rows did nothing. | Local-date filtering, workspace scoping, schedule order and working job-detail links. Supporting engines alone no longer make missing launchers look available. |
| Sheets lacked consistent focus handling and zoom was disabled. | Named dialogs, descriptions, focus boundaries, background inertness, scroll locking, nested Escape handling, close safeguards, reduced-motion styling, accessible customer picker and restored page zoom. |
| Floating dependencies and incomplete lint coverage weakened reproducibility. | Pinned runtime dependencies, a committed lockfile, npm ci, linting of JS/MJS/CJS, and a CodeQL security gate. |

The $45/room cleaning floor, 1.5× stair labor rule, separate price review, customer-safe receipt and explicit send confirmation remain covered. No customer messages, paid model calls or production data restorations were performed during verification.

## Evidence and release gates

The final local regression run passed **3,943 assertions across 189 suites**, plus the intelligence smoke test. Focused coverage includes competing storage clients, lost-update prevention, malformed backup acknowledgements, corrupted imports, recovery interrupted by quota failure, preserved conflicting copies, actual conflict-resolution screen handlers, signature tampering and concurrent API budgets. Tests run in the repository's Node/VM harness, not in a real browser.

ESLint covers `.js`, `.mjs` and `.cjs`: zero errors and 35 existing unused-variable warnings. The production dependency audit returned zero known vulnerabilities. This is dependency evidence, not proof that application endpoints have no vulnerabilities.

CI must pass ESLint, the full test suite, Netlify function bundling, Firestore emulator rules and the new CodeQL scan before this PR is merged. CodeQL checks the JavaScript/TypeScript codebase with security-extended queries. The SARIF gate blocks endpoint security findings and high/critical findings elsewhere. A green scan is bounded evidence; authentication/business-logic tests are still necessary.

Local Netlify build verification did not finish: a network-approval request was canceled. The existing CI build gate remains mandatory. Graphify update was attempted but its CLI is unavailable. The previous browser attempt was blocked with `net::ERR_BLOCKED_BY_CLIENT`; there is no new visual, Axe, screen-reader, physical-phone, Bluetooth, native-share or printing certification in this pass.

## Deployment and migration

Server configuration is required for private APIs:

- Set `APP_ALLOWED_USER_IDS` to the explicitly authorized operator UIDs and `APP_AUTH_PROVIDER` to `firebase` or `supabase`. If absent, the existing `OPENAI_ALLOWED_USER_IDS` and `OPENAI_AUTH_PROVIDER` settings remain the compatibility fallback. OpenAI still uses its own allowlist.
- Firebase verification requires `FIREBASE_PROJECT_ID` and `FIREBASE_WEB_API_KEY`. Supabase verification requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Sign in through the existing Cloud Settings UI. Missing configuration fails closed.
- Netlify Blobs must be available for both private backups and the shared request budget. Budget/storage outages do not permit unpaid or unauthenticated fallbacks.
- Twilio callbacks require `TWILIO_AUTH_TOKEN`. Set `TWILIO_STATUS_CALLBACK_URL` to the exact configured public callback URL if the hosting proxy rewrites the request URL. SendGrid callbacks require `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`; enable signed event delivery. Sensing requires `SENSE_WEBHOOK_SECRET`.
- Receipt blobs now use account-scoped hashed keys. Earlier global receipt blobs and the legacy shared sync `state` are not exposed, deleted or assigned to a caller automatically. An operator must attribute legacy data explicitly before migrating it.
- Unscoped legacy records are included only for the default workspace. Backups for a named workspace exclude and count unscoped records rather than guessing ownership. New customer and job records carry the current workspace.
- Security headers enforce frame/object/base restrictions. The full script policy is report-only because legacy inline scripts remain. HSTS preload and a strict self-only script policy were not enabled without a deployment-wide compatibility review.

## Boundaries that still prevent 10/10

1. **Recovery coverage:** six collections are backed up: jobs, customers, quotes, working quote forms, audit records and quote outcomes. Photos, other domain stores and cloud configuration are excluded. The file is JSON with a corruption checksum, not an encrypted or signed archive. Only trusted files should be restored. User-managed encryption and a complete IndexedDB event history remain future work.
2. **Restore atomicity:** each collection replacement is atomic at the localStorage-key level. A restore across several collections can stop partway through; it is deliberately add-only and safely resumable. The full incoming archive is retained before writes. This is not the proposed all-stores IndexedDB transaction and does not claim zero-loss under device destruction or exhausted storage.
3. **Concurrency scope:** browser Web Locks coordinate same-origin tabs. The fallback serializes only one runtime. Cloud backups are per device; they do not implement collaborative quote editing across separate devices. Remaining legacy mutators outside the quote workflow still need revision discipline and role/workspace review.
4. **Authentication scope:** the server uses verified account allowlists, not a new enterprise role/workspace membership service. Existing Firebase/Supabase authorization remains in place. Live session expiry/revocation, deployment credentials and operator onboarding need deployment verification.
5. **Operations:** backup history is retained and its listing is capped at 100 copies. Retention, pagination, storage-cost monitoring, device naming and a complete disaster-recovery drill are still needed for larger deployments.
6. **Accessibility and devices:** shared-dialog keyboard behavior is improved, but a comprehensive browser/Axe and manual screen-reader audit across all older dialogs is outstanding. Run the full field workflow on the Pixel, offline and after a PWA upgrade, including cancellation, microphone/camera permission denial and printing.
7. **Competitive completeness:** this release improves entry points to existing tools. It does not deliver new payment processing, route optimization, online booking, signature tracking, good/better/best packages or a finished customer portal.

The practical next acceptance exercise is a real customer-free field rehearsal: create a customer, measure, quote, edit in two tabs, resolve, approve, cancel sharing, reopen offline, export, restore into another device and verify prices and history. Then validate authenticated cloud backup and provider callbacks against staging credentials.

## Competitive grounding

Jobber already supports mobile quoting, customer selection, quote follow-ups and a client hub; these are useful benchmarks for reducing duplicate entry and shortening the next action. See [Jobber features](https://www.getjobber.com/features/) and [mobile quotes](https://help.getjobber.com/en/articles/quotes-in-the-jobber-app/). Housecall Pro groups scheduling, estimates, customer management and payments into clear daily workflows; see [Housecall Pro features](https://www.housecallpro.com/features/). These are established competing capabilities, not evidence that competitors have only slow legacy forms.

Technical references: [Web Locks specification](https://www.w3.org/TR/web-locks/), [IndexedDB transaction lifecycle](https://www.w3.org/TR/IndexedDB-3/), [modal-dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [Twilio request signatures](https://www.twilio.com/docs/usage/security), [SendGrid event signatures](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features), and [CodeQL Action](https://github.com/github/codeql-action).

## Rollback and post-merge audit

Revert application changes through a reviewed PR while preserving localStorage, receipt blobs, current backup objects and history objects. Do not return the public global sync endpoint to service. The snapshot format, restore archives, working-copy base inputs and device metadata are additive; older code will not understand all recovery features.

After merging, confirm the exact merge SHA, all required checks, the changed file set, preserved pricing/review boundaries and deployment limitations. Record that evidence in the final delivery. Repository integration alone must not be described as a verified production deployment.
