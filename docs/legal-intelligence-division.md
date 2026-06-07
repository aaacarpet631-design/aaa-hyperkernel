# AAA HyperKernel — Legal Intelligence Division

> **Not legal advice.** This division is an *advisory* and *documentation* system. It
> identifies risk, preserves evidence, improves documentation, and recommends
> **human attorney review**. It does not practice law, represent the company, or
> guarantee outcomes. Every legal agent prompt and every advisory output carries this
> guardrail as a hard constant, not a setting.

## 1. Design philosophy

The division is built **on top of** the kernel that already exists, not beside it.
Reusing proven infrastructure is what makes it production-grade rather than a parallel
silo:

| Capability the directive asks for | Existing kernel primitive it reuses |
|---|---|
| Immutable audit system | **Runtime Gateway** (`aaa-runtime-gateway.js`) — every guarded mutation → append-only `audit_log`, with hard AI-blocks on human-only actions |
| Permissions | **RBAC** (`aaa-rbac.js`) — deterministic, fail-closed matrix mirrored by Firestore rules |
| Risk → escalation | **Escalation Policy** + **Challenge Protocol** (Critic → Risk → Counterargument → Supervisor) |
| "Re-score all contributors" | **Supervisor** scoring + **Prediction Ledger** |
| "Everything connects / searchable" | **Knowledge Graph** + shared memory (`AAA_DATA`) |
| Agent org + scoring | **Agent Registry / Agent OS** (`DECISION_SCHEMA`, `logDecision`) |
| Events | **Event bus** (`AAA_EVENTS`) |

## 2. Governance structure (the AI legal org)

```
Chief Legal Intelligence Officer (CLIO)   — supervises, coordinates, maintains the risk dashboard, escalates
├── Contract Intelligence Team
│   ├── Contract Builder        ├── Contract Review     ├── Clause Risk
│   ├── Signature Compliance     └── Change Order
├── Compliance Intelligence Team
│   ├── Regulatory Monitoring    ├── Employment Compliance
│   ├── Contractor Compliance    ├── Insurance Compliance   └── Licensing Compliance
├── Risk Intelligence Team
│   ├── Liability Analysis       ├── Litigation Risk
│   ├── Evidence Preservation     └── Documentation Quality
├── Collections & Payment Protection Team
│   ├── Collections             ├── Lien Documentation
│   ├── Payment Risk             └── Invoice Enforcement
└── HR & Workforce Legal Team
    ├── Employment Documentation ├── Policy Review
    ├── Incident Review          └── Workforce Risk
```

Every agent runs through the **same** `AAA_DATA.callAgent` path + `DECISION_SCHEMA`
as the rest of the OS, so its decisions are logged to shared memory, scored by the
Supervisor, and visible in the Prediction Ledger. No legal agent can finalize a
binding action — they emit *recommendations*; a human approves through the Gateway.

## 3. Legal memory system (`legal_records`)

Single versioned, append-only collection. **Nothing is silently modified** — every
revision increments `version` and pushes the prior snapshot into `history`.

```jsonc
{
  "id": "legal-…",
  "type": "contract | change_order | acknowledgement | incident | compliance_event |
           legal_review | communication | evidence | lien | collection | policy",
  "workspaceId": "…",
  "title": "…", "summary": "…",
  "source": "human:owner | agent:contract_review | crm | accounting | …",
  "author": "uid/role/agent id",
  "createdAt": 0, "updatedAt": 0, "version": 1,
  "status": "open | active | resolved | escalated | expired | signed | void",
  "riskScore": 0, "riskSeverity": "low|medium|high|critical",
  "confidence": 0,                       // 0–100, of the source/extraction
  "links": { "jobId": null, "customerId": null, "contractId": null, "decisionId": null },
  "data": { /* type-specific payload, e.g. compliance: { obligation, dueDate, authority } */ },
  "history": [ { "version": 1, "at": 0, "author": "…", "change": "created", "snapshot": {…} } ],
  "auditIds": [ "audit-…" ]              // Gateway audit entries tied to this record
}
```

Required on every item (directive): **source, timestamp, author, confidence, risk, audit
trail** — all present above.

## 4. Legal risk engine

`AAA_LEGAL_RISK.assess(context)` returns the exact contract the directive specifies,
plus a per-category breakdown. Pure, deterministic, grounded only in real data:

```jsonc
{
  "risk_score": 0,                 // 0–100 overall (max of weighted categories)
  "severity": "low|medium|high|critical",
  "contributing_factors": [ "…" ],
  "mitigation_actions": [ "…" ],
  "escalation_required": false,
  "categories": {
    "contract": 0, "payment": 0, "compliance": 0,
    "employment": 0, "documentation": 0, "reputation": 0
  }
}
```

Category signals (all from real shared memory; absent data → low, never invented):
- **Contract** — high-value job with no signed contract; unsigned change orders.
- **Payment** — large unpaid/overdue balance; no deposit on big jobs.
- **Compliance** — overdue `compliance_event` obligations; missing license/insurance records.
- **Employment** — open incidents; missing acknowledgements.
- **Documentation** — jobs missing photos/measurements/signatures; thin records.
- **Reputation** — disputes, callbacks, lost outcomes with exposure language.

It composes with the existing **Escalation Policy**: `escalation_required` feeds the
same Challenge Protocol so high legal risk gets adversarially reviewed.

## 5. Attorney escalation protocol

`AAA_LEGAL.escalateToAttorney(context)` prepares a **fact + evidence package** (never
advice): summarized facts, linked contracts/jobs/communications, preserved evidence
refs, and the risk breakdown. It writes a `legal_review` record (status `escalated`)
through the Gateway action `PREPARE_LEGAL_REVIEW` (AI-allowed — preparing a package is
advisory) and emits `legal.escalated`. A human with `MANAGE_LEGAL` dispositions it
(`RESOLVE_LEGAL_REVIEW`, human-only).

## 6. Permissions (RBAC additions)

| Permission | Owner | Manager | Crew |
|---|:--:|:--:|:--:|
| `VIEW_LEGAL` (War Room) | ✓ | ✓ | — |
| `MANAGE_LEGAL` (add/resolve legal records) | ✓ | ✓ | — |
| File incident (`FILE_INCIDENT`, any member) | ✓ | ✓ | ✓ |

## 7. Gateway actions (audited)

| Action | Permission | AI allowed? |
|---|---|:--:|
| `ADD_LEGAL_RECORD` | `MANAGE_LEGAL` | no |
| `FILE_INCIDENT` | any member | no |
| `PREPARE_LEGAL_REVIEW` | any member | **yes** (advisory package) |
| `RESOLVE_LEGAL_REVIEW` | `MANAGE_LEGAL` | no |

## 8. Event model

`legal.record.added`, `legal.record.revised`, `legal.escalated`,
`legal.compliance.due`, `legal.incident.filed` — all on the existing bus, so automation
and analytics can react exactly like operational events.

## 9. Legal War Room (UI)

One executive command center, opened from the Command Center (gated on `VIEW_LEGAL`),
with a permanent non-advice disclaimer banner and these views, each read-only with
honest empty states and drill-down:

1. Risk Overview (company score + per-category)  2. Active Risks  3. Compliance Status
4. Contract Pipeline  5. Payment Disputes  6. Documentation Gaps  7. Incident Reviews
8. Escalated Legal Reviews  9. Audit Activity (legal entries)

## 10. Implementation phases

- **Phase 1 (this PR):** memory layer, risk engine, agent org + attorney-escalation
  guardrail, War Room, RBAC + Gateway + Command Center wiring, tests. *Foundation
  everything else hangs on.*
- **Phase 2:** contract intelligence depth (clause-level diff/flagging on real
  contracts), compliance obligation scheduler with deadline alerts via automation.
- **Phase 3:** collections/lien document-package generation, incident workflow with
  acknowledgement tracking, full audit-package export (PDF), knowledge-graph legal
  node types.
- **Phase 4:** regulatory monitoring feeds, litigation-risk trend in the Prediction
  Ledger, automated evidence preservation on `job.closed`.

## 11. Success criteria mapping

Continuous compliance monitoring (§4 compliance category + Phase 2 scheduler) ·
enterprise documentation (§3 versioned memory) · auditability (Gateway, §7) · contract
intelligence (Contract team + Phase 2) · risk visibility (War Room §9) · escalation
management (§5) · evidence preservation (`evidence` records + Phase 4) · executive legal
dashboard (§9).
