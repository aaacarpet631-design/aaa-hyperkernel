# UI Polish Slice — Red Command Shell

## Intent

Make the app feel more modern, red-branded, and easier to scan on a phone without changing business logic.

## Pixel 10 Pro target

The polish layer is tuned for the owner's Pixel 10 Pro class device: a 6.3-inch, 20:9, high-density Android display. The CSS intentionally avoids hard-coding one exact browser viewport and instead targets the realistic portrait CSS-width band for Pixel-class Android PWAs.

Pixel 10 Pro priorities:

- bigger thumb targets for truck/jobsite use
- safer bottom spacing around Android gesture navigation
- clearer bottom-nav active state
- larger START MEASUREMENT CTA
- less cramped 3-column KPI tiles
- better portrait rhythm for one-handed use
- usable rotated/landscape layout for truck-desk review

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
- Adds Pixel 10 Pro / similar 6.3-inch Android portrait tuning.
- Adds Pixel 10 Pro landscape readability tuning.

## Non-goals

- No measurement logic changes.
- No quote/pricing changes.
- No storage or sync changes.
- No governance or workforce runtime changes.
- No navigation behavior changes.

## Manual QA

1. Open the app on the Pixel 10 Pro.
2. Confirm Field Mode START MEASUREMENT remains visible, centered, and easy to tap.
3. Confirm Executive Mode Command/Business/Jobs/Chat tabs still render.
4. Confirm bottom nav active state is visible above Android gesture navigation.
5. Confirm Jobs cards are easier to scan, especially Needs Attention.
6. Confirm KPI tiles fit without cramped labels in portrait.
7. Rotate the phone and confirm the main content remains readable.
8. Confirm no blank screen if `css/ui-polish.css` fails to load; the app should still run because CSS is non-blocking.
