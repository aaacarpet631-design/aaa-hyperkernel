const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const hud = fs.readFileSync(path.join(root, 'js', 'bluetooth', 'screens', 'measurement-hud-ui.js'), 'utf8');

assert.ok(hud.includes("label: 'Measure manually'"), 'scanner should show a visible manual measurement button');
assert.ok(hud.includes("icon: '📏'"), 'manual scanner action should use a ruler icon');
assert.ok(hud.includes('onClick: startManualCapture'), 'manual scanner action should open the existing manual capture flow');
assert.ok(hud.includes('Manual rooms save to the same review screen and quote flow'), 'scanner should explain manual rooms continue the same quote flow');
assert.ok(hud.indexOf("label: 'Scan (open picker)'") < hud.indexOf("label: 'Measure manually'"), 'manual option should appear directly under Scan');

console.log('Manual measurement scanner: ALL PASSED');
