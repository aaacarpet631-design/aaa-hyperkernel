# HyperKernel Chat Canvas

## Purpose
The app experience the owner actually needs: open the phone, type a question,
and HyperKernel answers with useful **interactive cards** — not walls of text,
not SMS. A mobile-first, offline-capable chat thread over the real Executive
Copilot, councils, ledgers, simulations, and goals.

## Architecture (`js/copilot/`)
```
type a message
  → chat-canvas              orchestrate (store → route → card → store)
       ├─ chat-message-store      append-only thread (survives reload)
       ├─ offline-chat-queue      queue when offline, replay when online
       ├─ chat-intent-router      delegates to the Executive Copilot router
       │                          + adds software_factory & governance_approval
       ├─ executive-copilot       the same governed brain the app uses
       └─ rich cards (built from REAL read-model output):
            executive-briefing-card · simulation-result-card ·
            goal-progress-card · software-factory-card · governance-approval-card
  → rich-card-renderer        card model → safe mobile HTML
  → copilot-ui                chatRenderModel() + DOM-guarded mountChat()
```

## Card flows
| Owner types | Card |
|---|---|
| "How are we doing today?" | **Executive Briefing** (summary, threats, opportunities, bottlenecks, confidence, missing data) |
| "Run simulation: raise repair pricing 5%" | **Simulation Result** (expected / best / worst revenue, assumptions, recommendation, approval-required) |
| "Create goal: add $50k/month revenue" | **Goal Progress** (target, current delta, capability gaps, experiments, approval-required) |
| "Build a review dashboard" | **Software Factory** (spec, files/tests/PR status, governed proposal — files/tests/PR honestly `pending`) |
| "Approve this change" / a protected action | **Governance Approval** (explicit approve/reject; nothing happens until approved) |

## Governance guarantees
- Chat uses the **existing** Executive Copilot intent router and governance.
- Protected actions render an **approval card** with `requiresApproval:true,
  approved:false` — never a direct mutation. Approval routes through Council
  Governance (RBAC + written reason).
- Software builds are **proposed** to governance, not silently shipped;
  files/tests/PR stay `pending` until the Genesis Foundry/a human builds them.
- No fabricated answers — unmappable scenarios and absent data render
  `insufficient_data`.
- No production mutation from any chat interaction (tested).

## Offline
`offline-chat-queue` detects connectivity (navigator.onLine, with an explicit
override for app events/tests). Offline messages are queued locally and
`replayQueue()` sends them in order when back online. The user message shows as
`queued` until replayed.

## Voice
Voice is future-ready via the existing `voice-input-adapter` (SpeechRecognition
when present, graceful text fallback) — the canvas never depends on it.

## UI
`copilot-ui.chatRenderModel()` returns the thread (each assistant message with
rendered card HTML) + suggested prompts; `mountChat(el)` renders a mobile-first
thread + input bar when a DOM exists (no-op otherwise). Pixel-friendly: single
column, scrollable thread, sticky input.

## Known limitations
- The Software Factory card proposes and tracks a build; actual code generation
  is dispatched to the Genesis Foundry post-approval (PR wiring is a follow-up).
- Intent routing is keyword-deterministic (paraphrase handled by adding terms);
  a governed LLM router is the future seam.
- Operations metrics / CAC remain `insufficient_data` until their telemetry is
  wired (honest by construction).

## Next recommended organ
**In-card actions** — approve/reject and "dispatch build to Genesis" directly
from the governance and software-factory cards (wired to the existing governed
endpoints), turning the canvas from read + propose into a fully governed
act-with-one-tap surface.
