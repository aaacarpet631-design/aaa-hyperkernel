# UI v2 Audit

Repo: `aaacarpet631-design/aaa-hyperkernel`

Branch target: `chatgpt/ui-v2-audit`

## Executive Summary

HyperKernel already has the right UI architecture for a fast mobile PWA:

- a mode controller (`AAA_APP_MODE`)
- a work-first Field Mode home (`AAA_FIELD_MODE_HOME`)
- a local-first job shell (`AAA_JOB_LIST_UI`)
- a measurement HUD with both Bluetooth and manual capture (`AAA_MEASUREMENT_HUD_UI`)
- a Chat Canvas backed by Executive Copilot and rich cards (`AAA_CHAT_CANVAS`, `AAA_COPILOT_UI`)
- an Executive Command Deck with a strong read model (`AAA_COMMAND_DECK`)
- a final CSS polish layer (`css/ui-polish.css`)
- service-worker cache versioning (`sw.js`)

The opportunity is not a rebuild. It is a disciplined polish pass that makes the existing system feel like one premium operating system.

The biggest UI problem is inconsistency between layers:

1. `css/job-list.css` defines the base red/black app theme and shared UI-kit classes.
2. `css/field-mode.css` adds a futuristic cyan-forward field skin.
3. `css/ui-polish.css` loads last and pushes the app back toward AAA red.

That stack works, but it creates a slightly divided visual identity. Slice 1 should keep the layering but make the red AAA system dominant and consistent.

## Screen Inventory

### App Shell

Files:

- `index.html`
- `js/ui/app-mode.js`
- `js/ui/job-list-ui.js`
- `css/job-list.css`
- `css/field-mode.css`
- `css/ui-polish.css`

Screens:

- Field Mode: Measure, Jobs, Chat, More
- Executive Mode: Command, Jobs, Chat, Business
- sticky header
- bottom tab bar
- voice FAB
- boot error screen
- build/cache stamp in More

Current strengths:

- Field-first launch is already implemented.
- Bottom nav changes per mode.
- Voice FAB is intentionally hidden on Chat and Command to avoid covering composer actions.
- `css-contracts.test.js` already guards the FAB hide specificity bug.

Current problems:

- The visual language is split between cyan "future OS" and red AAA brand.
- Some high-importance screens feel like styled modules rather than one product.
- The app has many capabilities, but the first viewport does not always tell the user the next best action.

### Measure Home

Files:

- `js/ui/field-mode-home.js`
- `css/field-mode.css`
- `css/ui-polish.css`
- `test/unit/field-mode.test.js`
- `test/unit/field-quick-actions.test.js`

Current strengths:

- The primary action is correct: `START MEASUREMENT`.
- Today's jobs are below the money action.
- Quick actions are honest about availability.
- `renderModel()` is DOM-free and testable.

Current problems:

- The primary action is strong, but the screen could explain the fallback better: manual or laser, works offline.
- Unavailable quick actions can feel dead to a field tech unless the UI gives a clear reason.
- Manual measurement is available through the measurement HUD, but should be more obvious as a field workflow.

### Measurement HUD

Files:

- `js/bluetooth/screens/measurement-hud-ui.js`
- measurement models/storage/BLE services loaded in `index.html`

Screens:

- setup
- scanner
- device details
- Bluetooth capture
- manual capture
- review rooms
- send to quote
- history
- troubleshooting/manual

Current strengths:

- Manual entry already exists and reuses the same capture/review flow.
- Bluetooth unsupported state already offers manual entry.
- Device details already has "Manual entry instead."
- Measurement math is centralized in the HUD logic and should not be touched in UI polish.

Current problem:

- The scanner screen shows `Scan (open picker)` but does not show a visible `Measure manually` button directly under it. This is the exact field failure path: if Bluetooth is not cooperating, the tech should keep moving immediately.

### Chat

Files:

- `js/copilot/copilot-ui.js`
- `js/copilot/chat-canvas.js`
- `js/copilot/rich-card-renderer.js`
- `js/copilot/executive-briefing-card.js`
- `css/field-mode.css`
- `css/ui-polish.css`
- `test/unit/chat-canvas.test.js`

Current strengths:

- Chat is not a toy shell; it routes through Executive Copilot.
- It supports rich cards, offline queue, Company Brain fallback, and governed approval cards.
- It already avoids fake answers by surfacing insufficient data.

Current problems:

- `mountChat()` renders a sparse chat surface.
- There is no strong empty/welcome state.
- Simple openers like "Hi" should produce a useful business copilot card, not a low-value answer.
- Loading/error states need to feel deliberate.
- Rich cards need stronger mobile presentation and width discipline.

### Executive Command

Files:

- `js/ui/command-deck-ui.js`
- `css/command-deck.css`
- `css/ui-polish.css`
- `test/unit/command-deck.test.js`

Current strengths:

- The read model is excellent and null-safe.
- It already separates:
  - Company Pulse
  - Supervisor Report
  - Mission Feed
  - Agent Network
  - Opportunity Radar
- Tests prove no fake revenue and honest warming-up states.

Current problems:

- The first viewport should lead with "what needs your attention," then money/risk.
- Passive telemetry should sit below actionable owner work.
- Cyan styling is still more prominent than AAA red.
- Opportunity cards should look like decisions, not just analytics.

### Jobs

Files:

- `js/ui/job-list-ui.js`
- `css/job-list.css`
- `css/ui-polish.css`

Current strengths:

- Jobs are grouped by urgency, not just lifecycle.
- Summary strip exists.
- Job detail is wired into real HUDs.

Current problems:

- Job cards need stronger hierarchy: customer, address, state, next action.
- New Job should be easier to hit and visually important.
- "Needs Attention" should dominate the Jobs tab when present.

### More

Files:

- `js/ui/job-list-ui.js`
- `js/ui/app-mode.js`

Current strengths:

- Mode switch exists.
- "Always open to Measure" preference exists.
- Build stamp checks cache version.

Current problems:

- More is functional but not yet a clean control center.
- Controls should be grouped by Mode, Startup, Tools, Build.
- Language should be plain: `Switch to Executive Mode`, `Switch to Field Mode`.

## File Map

### Primary UI Files

| File | Role | Slice |
|---|---|---|
| `index.html` | load order and PWA shell | audit only unless adding assets |
| `js/ui/app-mode.js` | mode/nav/landing tab | Slice 5 |
| `js/ui/job-list-ui.js` | app shell, jobs, tabs, More | Slices 4-5 |
| `js/ui/field-mode-home.js` | Measure home | Slice 2 |
| `js/bluetooth/screens/measurement-hud-ui.js` | scanner/manual/review/quote measurement flow | Slice 2 |
| `js/copilot/copilot-ui.js` | Chat UI mount and render model | Slice 3 |
| `js/copilot/chat-canvas.js` | chat send/routing/offline behavior | Slice 3 only if greeting/fallback belongs here |
| `js/copilot/rich-card-renderer.js` | mobile rich-card HTML | Slice 3 |
| `js/ui/command-deck-ui.js` | Executive Command model/render | Slice 4 |
| `js/ui/ui-kit.js` | shared primitives | only if tiny primitive needed |

### CSS Files

| File | Role | Slice |
|---|---|---|
| `css/job-list.css` | base theme, shared UI-kit styles, jobs | Slices 1 and 5 |
| `css/field-mode.css` | Field Mode, Chat Canvas, bottom nav, rich cards | Slices 1-3 |
| `css/command-deck.css` | Executive Command styling | Slice 4 |
| `css/ui-polish.css` | final polish layer, red brand, Pixel tuning | Slices 1-6 |

### Tests

| File | Role |
|---|---|
| `test/unit/field-mode.test.js` | app mode and Field home model |
| `test/unit/field-quick-actions.test.js` | quick action routing |
| `test/unit/chat-canvas.test.js` | chat behavior, routing, cards, offline |
| `test/unit/command-deck.test.js` | executive deck data contract |
| `test/static/css-contracts.test.js` | CSS visual-contract guards |
| `test/smoke/boot.test.js` | script load/order smoke |
| `test/run.js` | full suite runner |

### PWA Cache

| File | Role |
|---|---|
| `sw.js` | cache version and precache list |

Any visible CSS/JS change must bump `CACHE_NAME` from the current version and ensure the changed asset path is precached.

## Risk Map

### High Risk

- Changing measurement math in `measurement-hud-ui.js`.
- Changing quote/pricing behavior through UI polish.
- Adding a framework or new build system.
- Editing `index.html` load order without a strong reason.
- Changing `AAA_CHAT_CANVAS.send()` behavior in a way that breaks offline queue or governed approval cards.

### Medium Risk

- CSS specificity conflicts between `job-list.css`, `field-mode.css`, and `ui-polish.css`.
- Voice FAB overlapping Chat composer again.
- Service-worker stale cache hiding visible changes on Android.
- Over-styling Command Deck and reducing information density.

### Low Risk

- Adding copy/helper text.
- Adding a scanner manual button wired to existing `startManualCapture`.
- Improving empty states.
- Adjusting CSS tokens in `ui-polish.css`.
- Adding unit/static tests for UI contracts.

## Slice 1 Implementation Plan

Goal: unify the design language before workflow changes.

Scope:

- `css/ui-polish.css`
- `css/field-mode.css` only for conflicts that cannot be solved cleanly in polish
- `css/job-list.css` only if base token duplication is actively causing conflict
- `test/static/css-contracts.test.js`
- `test/smoke/boot.test.js`
- `sw.js`

Do:

1. Make AAA red the primary brand signal everywhere.
2. Reduce cyan to secondary/status use.
3. Normalize cards:
   - border color
   - panel background
   - subtle shadow
   - text hierarchy
4. Normalize buttons:
   - primary red
   - 56px target on Pixel-class phones
   - consistent radius
   - no layout shift on active state
5. Normalize bottom nav:
   - clear active tab
   - 64-72px thumb-safe height
   - safe-area padding
6. Add/review `prefers-reduced-motion`.
7. Confirm Chat composer and voice FAB do not overlap.
8. Bump `sw.js` cache version.

Do not:

- Touch measurement math.
- Touch pricing.
- Touch quote lifecycle.
- Touch chat routing logic.
- Touch Command Deck data model.
- Add a new CSS framework.

Acceptance:

- Field Mode, Jobs, Chat, Command, Business, and More share the same red/dark system.
- Primary actions are visibly red.
- No primary tap target under 48px.
- Chat composer is not covered by the voice FAB.
- Bottom nav does not cover content.
- Reduced-motion users do not get sweep/pulse animation overload.
- Full suite passes.

## Slice 2 Implementation Plan

Goal: fastest possible measurement path.

Scope:

- `js/ui/field-mode-home.js`
- `js/bluetooth/screens/measurement-hud-ui.js`
- `css/ui-polish.css`
- tests for field mode and measurement scanner placement
- `sw.js`

Do:

1. Add a Field home helper line under START MEASUREMENT: `Manual or laser - works offline.`
2. Make unavailable quick actions explain themselves when tapped.
3. Add `Measure manually` directly under `Scan (open picker)` on the scanner screen.
4. Wire it to existing `startManualCapture`.
5. Add helper text that manual rooms save to Review Rooms and Send to Quote.
6. Keep current manual capture fields and calculations.

Acceptance:

- Measure -> scanner -> Measure manually -> manual capture -> Save room -> Review rooms works.
- Unsupported Bluetooth still offers manual entry.
- Tests prove button placement and wiring.
- No formula/pricing changes.

## Slice 3 Implementation Plan

Goal: Chat feels like a business assistant.

Scope:

- `js/copilot/copilot-ui.js`
- `js/copilot/chat-canvas.js` only if deterministic greeting fallback belongs in behavior
- `js/copilot/rich-card-renderer.js`
- `css/ui-polish.css`
- `test/unit/chat-canvas.test.js`
- possible new `test/unit/copilot-ui.test.js`
- `sw.js`

Do:

1. Add Chat empty state with:
   - greeting
   - quick action chips
   - useful business prompts
2. Add deterministic greeting handling for `hi`, `hello`, `hey`.
3. Add loading bubble.
4. Add failure state that keeps the user message.
5. Improve rich-card width, spacing, and readability.

Acceptance:

- Chat does not open blank.
- `Hi` produces a useful business card.
- Offline queue still works.
- Missing data remains honest.
- Approval cards still do not mutate production.

## Slice 4 Implementation Plan

Goal: Executive Command surfaces owner action first.

Scope:

- `js/ui/command-deck-ui.js`
- `css/command-deck.css`
- `css/ui-polish.css`
- `test/unit/command-deck.test.js`
- `sw.js`

Do:

1. Put Supervisor/attention section before passive analytics when useful.
2. Keep KPI tiles compact and scannable.
3. Style opportunity cards as decisions.
4. Clarify probability source.
5. Keep empty states honest.

Acceptance:

- Owner sees next action in the first viewport.
- No fake revenue, confidence, or opportunity probability.
- Tests remain null-safe.

## Slice 5 Implementation Plan

Goal: Jobs and More feel finished.

Scope:

- `js/ui/job-list-ui.js`
- `js/ui/app-mode.js`
- `css/job-list.css`
- `css/ui-polish.css`
- relevant tests
- `sw.js`

Do:

1. Strengthen Needs Attention section.
2. Improve job card hierarchy.
3. Make New Job easier to tap.
4. Group More controls into clear sections.
5. Clarify mode-switch labels.
6. Preserve build stamp.

Acceptance:

- Daily operations are one-hand scannable.
- More reads like a control center.
- Field-first default remains.

## Manual QA Checklist

Viewport targets:

- Pixel 10 Pro portrait approximation: `412 x 915`
- Pixel 10 Pro landscape approximation: `915 x 412`
- Small Android: `360 x 800`
- Desktop smoke: `1280 x 900`

Screens:

- Measure home
- Measurement setup
- Scanner disconnected
- Manual capture
- Review rooms
- Jobs
- Job detail
- Chat empty
- Chat after `Hi`
- Command
- Business
- More
- Any touched bottom sheet/modal

Checks:

- no blank screen
- no horizontal scroll
- no clipped buttons
- no bottom-nav overlap
- no FAB covering Send
- text wraps inside cards
- tap targets are large enough
- reduced motion is acceptable
- cache version visibly updates after deploy

## Recommended Next Step

Proceed to Slice 1 only:

> UI Foundation and Design Tokens.

This should be a small PR focused on CSS consistency, reduced motion, tap targets, nav polish, and service-worker cache bump.

Do not touch Field workflow or Chat behavior until Slice 1 lands clean.
