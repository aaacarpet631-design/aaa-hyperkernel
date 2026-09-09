# Quote builder audit — September 9, 2026

Scope: PR #93, `codex/functional-quote-builder`, beginning at commit `9b14b98b8d851e0e371f8fb704e6d348352b2fd8`. This review concerns the connected quote workflow, not the entire HyperKernel platform or the live quality of its AI models.

## Rating

**Before: 6.5/10. After this correction pass: 7.5/10.** These are engineering judgments, not measured benchmark scores.

The original work connects real pricing, quote persistence, approval and customer sharing. Its baseline is reproducible: 3,767 assertions passed across 186 suites, plus the intelligence smoke test. It deserves credit for deterministic pricing, separate customer receipts, explicit send confirmation and revision checks.

The score was held back by preventable data loss and misleading form behavior that the earlier tests missed. Passing module tests did not establish that the phone workflow was finished. The improvements remove the defects below, but browser/device verification, cross-tab conflicts and durable cloud backup remain open. Those limits prevent a production-ready rating.

## Findings and corrections

| Finding in the reviewed code | Consequence | Correction |
| --- | --- | --- |
| All working forms wrote one workspace slot; multiple editors could stay open. | Another quote could overwrite incomplete work that was never saved to the pipeline. | Separate recovery keys, an unfinished-form picker and one active editor. Switching first saves the old form; failed storage keeps it open. |
| Blank material prices were interpreted as absent overrides; blank counts became one. | Clearing an input could leave a valid-looking price based on an unintended default. | Require cleared values to be reentered. Explicit zero material prices remain supported. |
| A cleaning minimum below $45 stayed visible while the engine enforced $45. | Displayed pricing settings disagreed with the calculated total. | Reject the lower minimum with an explanation. |
| Quote, audit and supervisor cloud mirrors were awaited before local workflow completion. | A stalled backup could leave saving, approval or recording a won job waiting indefinitely. | Confirm local persistence independently. Preserve local auditing/scoring; order quote mirrors and keep the newest pending snapshot per quote. |
| Every open sheet handled Escape. | Canceling approval could also close the editor underneath it. | Only the top sheet handles dismissal; cleanup runs once. |
| Automatic-save success and action errors shared one status element above a long form. | A late auto-save message could replace a save error, and the owner might not see the error beside the button. | Separate status elements and place action errors by the controls. |
| Revision conflicts on Save offered only an error. | Recovery existed when reopening, but was not directly available at the failure point. | Offer recovery immediately while retaining local input. |

## Verification

- Baseline: `TZ=UTC npm test` — 3,767 assertions, zero failures, 186 suites; intelligence smoke passed.
- Correction pass: `TZ=UTC npm test` — 3,807 assertions, zero failures, 186 suites; intelligence smoke passed. The 40 additional assertions cover the cases above, including a cloud promise deliberately left unresolved. The unfinished-form picker also passed its focused handler test after the full run.
- ESLint: zero errors; the same 36 pre-existing warnings remain.
- Netlify offline build and function bundling passed. No deployed-provider calls or customer messages were made.
- Graphify query/update cannot run because its CLI is unavailable.
- Browser setup succeeded, but local navigation was rejected with `net::ERR_BLOCKED_BY_CLIENT`. Browser visual QA, real service-worker offline reload, native sharing and printing are not verified.

The new tests exercise actual modules and screen handlers in the repository's test harness. They do not establish physical-device behavior or distributed concurrency guarantees.

## Remaining release gates

1. Exercise the exact version on a Pixel: create → close/reopen → edit → approve → cancel/share/copy/print → explicitly record sent. Check layout, keyboard, focus and readable error placement.
2. Reload the installed PWA without a network connection and confirm saved and unfinished quotes survive. The service-worker tests simulate events; they are not this device test.
3. Resolve concurrent writes across browser tabs and devices before treating this as a multi-writer system. Current revision serialization and the single-editor guard cover only one runtime.
4. Add a durable cloud outbox with observable delivery/retry state if guaranteed backup is required. Current cloud mirroring is best effort, in-memory and interruptible on app closure. Separate unfinished forms remain device-local.
5. Review the dependency on PR #92 before merging the stack. No merge, production deployment, live model verification or customer delivery is included in this audit.

## Rollback

Revert this correction commit for the prior quote behavior. Existing quote records retain their format. Recovery data is additive in the existing working-form collection; the active pointer retains a compatible `value` for the prior builder. Older code can resume the active form but cannot list the additional recovery entries. Do not erase those entries during rollback.
