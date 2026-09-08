# Connected quote builder

The field estimator previously displayed a transient recommendation without saving it to the quote pipeline. Measurement quoting could attach an estimate to a job, but did not provide an editable customer quote. The pipeline's “Send to customer” action only recorded a status change.

The owner can now open **Field Mode → Quick Estimate**, **Command Center → Quote builder**, or **Quotes → Build a quote**. The existing vanilla PWA, role model, pricing engine and quote collection are retained.

## Owner workflow

1. Enter a customer name and optional phone, email and address. A job is optional.
2. Add cleaning, repair, stretching, installation, stairs, hallway, apartment-turn, commercial or custom work lines. Select carpet/padding names where relevant.
3. Continue to pricing. Check the per-quote rate snapshot, selected material prices and customer receipt. Defaults are starting rates requiring review, not verified current business prices.
4. Save the draft. Subsequent saves update the same quote. The working form is saved on this device while typing; saved quotes appear in the existing pipeline.
5. Review and approve the saved version. Any edit returns it to draft and removes approval. A sent quote is preserved; use a new quote for revised work.
6. Open a text or email composer, use native sharing, copy the receipt, or print/save PDF. These actions do not record delivery. Select **I sent this quote** only after sending it yourself.
7. Use the existing pipeline to record follow-up, won/lost, the actual job cost when known and the reason for the outcome.

When reopening the builder, a clean working copy loads the current saved revision. A sent or otherwise locked quote starts a fresh form. If unsaved work conflicts with the saved quote, the owner can keep those changes as a separate draft or explicitly replace them with the latest editable version. Recovery never rewrites a sent quote or silently discards conflicting edits. An unreadable working form leaves the new-quote form and Saved quotes accessible.

Closing a confirmation with ×, Escape, the backdrop or Cancel resolves as cancellation. Only the explicit confirmation button approves the action, so a dismissed approval cannot leave the quote screen waiting indefinitely.

The measurement HUD's **Build draft quote** action carries measured work into this same builder. It uses the active capture session, selected job or rooms recorded in that HUD; a jobless capture never imports every older measurement. Deleted rooms are excluded. Services use the relevant measurement types, and measured stairs get a separate stair line. Crew retain the existing field estimator; the new workspace and financial pipeline are owner-only.

## Pricing and persistence

- Uses `AAA_MEASUREMENT_QUOTE.priceService`, with a saved rate snapshot. The builder does not call a language model to calculate money.
- Retains the $45-per-room cleaning floor and 1.5× stair labor rule. Larger measured cleaning areas and the configured trip minimum can increase the total.
- Applies the trip minimum once to the combined quote, using an explicit receipt adjustment when necessary. Legacy pricing callers keep their existing behavior.
- Rejects negative, non-finite and incomplete values. Receipt amounts sum to the stored total in cents.
- Keeps material allowance, rate snapshots and costing internals out of generated customer receipts. Manual descriptions and notes are owner-authored customer text; do not enter private costing information there.
- Selling rates do not establish actual cost or profit. Builder quotes leave cost/margin unknown until actual job cost is recorded.
- Quote writes request durable device storage. A failed localStorage write rolls back the in-memory quote and reports failure, instead of claiming a save. Other collections retain their previous best-effort behavior unless opting into `requirePersistent`.
- Working copies are device-local and workspace-scoped. Quote cloud mirroring retains the existing best-effort behavior; this change does not establish multi-device conflict resolution or guaranteed cloud backup.
- Revisions reject stale saves, review and share requests. Competing edits are serialized within one JavaScript runtime. This is not a distributed or cross-tab lock.
- Won/lost learning signals are written after the quote has been saved successfully.
- The service worker includes the new files, tolerates an individual precache failure, avoids caching error responses and does not return HTML for a missing offline script. Successful fetches keep the worker alive until their cache writes finish.

## Structured agent boundary

The browser-module contract is `AAA_QUOTE_BUILDER`, with input version `1`. It is not a newly deployed HTTP API or an authentication boundary.

```js
const input = AAA_QUOTE_BUILDER.fresh();
input.customer = { name: 'Example customer', phone: '', email: '', address: '' };
input.lines = [{ serviceId: 'carpet_shampoo', rooms: 3 }];

// Read-only calculation; no quote or business mutation.
const preview = AAA_QUOTE_BUILDER.preview(input);

// A separate AI-origin draft through the runtime gateway, with an audit entry.
// Uses the current configured rate card; AI-supplied rates are not accepted.
const proposal = await AAA_QUOTE_BUILDER.propose(input, { actor: 'estimator' });

// Human edits must identify the exact saved revision being changed.
const edited = await AAA_QUOTE_BUILDER.save(input, {
  id: quote.id,
  expectedRevision: quote.revision,
  actor: 'owner',
  origin: 'human'
});
```

`propose()` cannot revise an existing quote, supply custom selling prices, approve, send, post invoices or record payments. It recomputes totals from the configured rates and structured measurements. Agent drafts still require a person to verify that the measurements and proposed scope are correct. The existing browser gateway relies on application role/origin context; do not expose it as an unauthenticated remote agent endpoint.

`prepareShare(id, {expectedRevision})` returns an allowlisted customer receipt plus optional encoded composer URLs after checking permission, review status and revision. It does not transmit a message. Native share cancellation, copying, printing and opening a composer leave lifecycle status unchanged.

## Validation and release

New regression suites exercise calculated totals, invalid input, persistence across reloads, storage failures, revision conflicts, AI denials, customer-safe sharing and the screen handlers through save → edit → approve → compose → confirm sent. Existing pricing, estimator and quote lifecycle suites remain required.

The September 8 recovery pass adds executable coverage for reopening sent quotes, refreshing stale clean drafts, preserving conflicting unsaved edits, both recovery choices, confirmation dismissal and service-worker cache events under a simulated network. These are module/event tests, not browser or physical-device tests.

Run `TZ=UTC npm test`, `npm run lint`, and `npm run build:check`. The UTC setting preserves the existing field-mode greeting test assumption.

This work is based on the `codex/gpt-6-astra` change in PR #92. It does not deploy the app, configure provider credentials or verify live AI calls. The cloud browser could not open the local app in the September 8 session. Browser/device QA remains unverified: check Pixel composer behavior, native share, printing and a real offline reload before release. The repository's requested Graphify refresh cannot run without its CLI.
