# AAA HyperKernel — Tests

A committed, zero-dependency test harness so every PR is gated on real tests,
not just "it builds."

## Run everything
```bash
npm test
```
Runs (each suite in its own process so globals don't leak):

- **Unit suites** (`test/unit/*.test.js`) — RBAC, runtime gateway (AI block +
  audit), pricing hard rules ($45 shampoo floor / stairs), 9-point closure photo
  evidence, accounting (P&L / job costing), crew + tools, scheduling conflicts,
  contracts (sign + immutability), QuickBooks Online client (proxy-routed,
  approval-gated), portal links.
- **Function pure-logic suites** — `functions/qbo-proxy/test.js`,
  `functions/portal-proxy/test.js` (redaction whitelist, token lifecycle,
  retry/expiry helpers).
- **Static integrity** (`test/static/integrity.test.js`) — every JS file parses;
  every `index.html` script + `sw.js` precache path resolves; portal page wired.
- **Boot smoke** (`test/smoke/boot.test.js`) — loads every `index.html` script in
  order into a simulated browser global and asserts the core/logic modules
  define themselves without throwing (catches load-order bugs and load-time
  crashes across the whole script chain).

No `npm install` needed for `npm test` — the suite has no dependencies. The
nested `test/package.json` forces this tree to CommonJS (the repo root is an
ESM package), so the suites can `require()` the browser-global app sources.

## Firestore rules tests (emulator)
These prove the security rules actually enforce RBAC + isolation. They need the
Firebase emulator (Java) and a one-time install:

```bash
cd test/rules
npm install
npx firebase emulators:exec --only firestore --project demo-aaa-rules "npm test"
```
Or from the repo root: `npm run test:rules` (after the install above).

They verify: workspace isolation, crew cannot read financial collections (owner
can), `audit_log` is append-only + owner-read, member docs aren't client-writable,
and `integrations/**` (OAuth tokens) is fully denied to clients.

## CI
`.github/workflows/ci.yml` runs `npm test` on every PR/push, plus the rules
tests in a job that boots the Firestore emulator.

## Full app boot (manual / future)
The boot smoke test is a cheap proxy, not a DOM render. For true end-to-end
(render + click flows) use Playwright against a served copy of the app — not yet
included; tracked as a follow-up. The deep UI-module globals (command center,
job list) are exercised there rather than in the headless boot smoke.
