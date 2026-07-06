/*
 * UI polish loader smoke test.
 *
 * Keeps the visual polish slice honest: the stylesheet must exist and the app
 * mode controller must load it idempotently without changing navigation logic.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const cssPath = path.join(root, 'css', 'ui-polish.css');
const appModePath = path.join(root, 'js', 'ui', 'app-mode.js');

assert.ok(fs.existsSync(cssPath), 'css/ui-polish.css should exist');

const css = fs.readFileSync(cssPath, 'utf8');
assert.ok(css.includes('--aaa-red'), 'UI polish should define AAA red brand token');
assert.ok(css.includes('.aaa-tabbar'), 'UI polish should style bottom navigation');
assert.ok(css.includes('.fm-primary'), 'UI polish should style Field Mode primary measurement CTA');

const appMode = fs.readFileSync(appModePath, 'utf8');
assert.ok(appMode.includes('aaa-ui-polish-css'), 'app-mode should install the polish stylesheet once');
assert.ok(appMode.includes("/css/ui-polish.css"), 'app-mode should point at the UI polish stylesheet');
assert.ok(appMode.includes("{ tab: 'measure', icon: '📐', label: 'Measure' }"), 'Field Mode measure nav should remain intact');
assert.ok(appMode.includes("{ tab: 'business', icon: '📊', label: 'Business' }"), 'Executive Mode business nav should remain intact');

console.log('UI polish loader: ALL PASSED');
