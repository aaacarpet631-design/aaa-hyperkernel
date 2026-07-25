# Copilot contract — invalid / degradation fixture corpus (Slice F)

Named counter-fixtures for the eval release gate
(`test/unit/copilot-eval-gate.test.js`, mirrored by
`/workspace/custonllm/tests/test_copilot_eval_gate.py`; both repos carry
byte-identical copies of this directory). The top-level `MANIFEST.json`
covers the GOLDEN fixtures only — this directory is intentionally outside it.

Every file here must be REJECTED by its expected check, except the one valid
degradation fixture, which must be ACCEPTED:

| file | expected check |
| --- | --- |
| `sendable-draft.json` | schema — `sendBlocked:false` on a draft (drafts are never sendable) |
| `foreign-field.json` | schema — contract-foreign top-level field (`additionalProperties:false`) |
| `missing-sourceref.json` | schema — card fact without a `sourceRef` (grounding by construction) |
| `unknown-cardtype.json` | schema — `cardType` outside the discriminated union |
| `empty-evidence-refs.json` | schema — evidence claim with zero `sourceRefs` (`minItems:1`) |
| `confidence-overflow.json` | schema — confidence 150 (range is 0..100) |
| `wrong-version.json` | schema — `contractVersion` "2.0" (off-enum) |
| `fabricated-evidence.json` | **integrity** — schema-VALID on purpose; it cites `quotes:mutant_999`, a record `followups.request.json`'s packet never carried, so only `evidenceIntegrityIssues(request, response)` catches it. This is the anti-fabrication gate: if it ever validates AND passes integrity, the referential guard has been loosened. |
| `degraded-context-unavailable.response.json` | **VALID** — honest degradation: `degraded.reason context_unavailable`, `fallback local`, confidence 0, no cards, no evidence, populated `unknowns`, digit-free answer. The gate asserts it is ACCEPTED end-to-end (validity + groundedness + integrity) so honest "I don't know" replies can never be regressed into refusals. |

All schema-invalid fixtures derive from `followups.response.json` except
`sendable-draft.json` (from `draft-followup.response.json`);
`fabricated-evidence.json` pairs with `followups.request.json` for the
integrity check. If you add a fixture here, add its expectation to BOTH eval
suites (they fail loudly on any file without a declared expectation) and copy
the file byte-identically to the other repo.
