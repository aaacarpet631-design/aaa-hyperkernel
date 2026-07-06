# UI Polish Slice — Red Command Shell

## Intent

Make the app feel more modern, red-branded, and easier to scan on a phone without changing business logic.

## Scope

- Adds `css/ui-polish.css` as a presentation-only layer.
- Loads that stylesheet from `js/ui/app-mode.js` with an idempotent `<link>` injector.
- Improves visual hierarchy for:
  - app shell background
  - headers
  - AAA title mark
  - summary/KPI tiles
  - job cards
  - bottom navigation
  - primary and secondary buttons
  - Field Mode START MEASUREMENT CTA

## Non-goals

- No measurement logic changes.
- No quote/pricing changes.
- No storage or sync changes.
- No governance or workforce runtime changes.
- No navigation behavior changes.

## Manual QA

1. Open the app on mobile width.
2. Confirm Field Mode START MEASUREMENT remains visible and tappable.
3. Confirm Executive Mode Command/Business/J/Chat tabs still render.
4. Confirm bottom nav active state is visible.
5. Confirm Jobs cards are easier to scan, especially Needs Attention.
6. Confirm no blank screen if `css/ui-polish.css` fails to load; the app should still run because CSS is non-blocking.
