# HyperKernel Field Mode OS

## The problem
The app landed in a project-management screen ("3 In Progress / 0 Closed / 1
Needs Attention"). A field tech walking into a house doesn't think "show me all
jobs" — they think **measure**. The primary action wasn't the primary action.

## The fix: two apps in one
A mode controller makes HyperKernel land where the user actually works.

| | Field Mode (crews) | Executive Mode (owner) |
|---|---|---|
| Lands on | **START MEASUREMENT** | **"What should I focus on?"** |
| Bottom nav | Measure · Jobs · Chat · More | Focus · Jobs · Chat · Business |
| First thought | "Measure / capture this room" | "What matters today" |

Mode is field-first by default (the money action is one tap in), persists to
config, and toggles from **More**. Crews never see "AI Agents" — that's owner
mode, now behind the Executive/More surfaces.

## Components (`js/ui/`)
- **`app-mode.js`** (`AAA_APP_MODE`) — mode state (field|executive), role-aware
  default, persisted toggle, per-mode nav spec + landing tab. Pure/testable.
- **`field-mode-home.js`** (`AAA_FIELD_MODE_HOME`) — the Field Mode home:
  - time-aware personal greeting ("Good morning, Aaron")
  - one big **START MEASUREMENT** primary action
  - quick actions: 📷 Scan Room · 📐 Laser Measure · 📝 Quick Estimate · 🎤 Voice
    Note — each wired to the **real** capability (vision HUD, bluetooth/laser,
    quotes, voice HUD) and honestly `available:false` when its engine isn't loaded
  - **Today's Jobs below** the action (active/scheduled only; closed excluded)
  - "Ask HyperKernel" at the bottom (opens the Chat Canvas)
  - pure `renderModel()` (DOM-free, testable) + DOM-guarded `mount()`
- **`job-list-ui.js`** (shell) — rewired: the bottom tab bar is built from
  `AAA_APP_MODE.navItems()`, the app lands on the mode's home tab, and new tabs
  render the Field home (`measure`), Chat Canvas (`chat`), Executive focus
  (`focus`), and an owner **More** menu with the mode switch. Falls back to the
  classic three tabs if the mode controller isn't loaded.

## Flow
```
Open app → (Field Mode) Measure tab
  GOOD MORNING AARON
  ┌─────────────────────────┐
  │   📐 START MEASUREMENT   │   ← 1 tap
  └─────────────────────────┘
  📷 Scan · 📐 Laser · 📝 Estimate · 🎤 Voice
  Today's Jobs (active only)
  🤖 Ask HyperKernel — "What should I focus on?"
```
START MEASUREMENT begins a measurement session that is **job-optional** — measure
first, attach to a job later — routing to the measurement HUD / capture sequencer
when present.

## Honesty & safety
- Quick actions never pretend to run — an action whose engine is absent reports
  `available:false` and `startQuick` returns `unavailable` (no fake launch).
- No production mutation from the home (it reads jobs, routes to existing flows).
- Existing per-job "Measure Room" and all owner tools remain reachable.

## Tests
`test/unit/field-mode.test.js` (18): default mode + landing + nav per mode +
persisted toggle; greeting (time + name); START MEASUREMENT primary; four quick
actions with honest availability that flips when an engine loads; today's jobs
exclude closed; honest start/startQuick routing; greeting boundaries.

## Known limitations
- The home routes to existing HUDs (`AAA_MEASUREMENT_HUD_UI`, vision, voice) when
  present; a unified job-optional capture session is the natural follow-up.
- Mode default is field-first for everyone; a future managed setting could map
  owners to executive-by-default.

## Next recommended organ
A **job-optional Field Capture Session**: START MEASUREMENT → capture rooms (photo
+ laser + voice) into a draft that HyperKernel turns into measurements, material
quantities, waste/stair calcs, and a quote draft — then offers to attach/create
the job. The "Field Brain" that builds the quote without a keyboard.
