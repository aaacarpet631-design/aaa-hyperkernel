const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const router = fs.readFileSync(path.join(root, 'js', 'copilot', 'chat-intent-router.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'js', 'copilot', 'chat-canvas.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'js', 'copilot', 'rich-card-renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'ui-polish.css'), 'utf8');

assert.ok(router.includes("intent: 'greeting'"), 'router should classify greetings');
assert.ok(router.includes('business_copilot_home'), 'router should route greetings and help to copilot home');
assert.ok(router.includes('anything important'), 'router should understand owner shorthand');

assert.ok(canvas.includes('friendlyHomeCard'), 'canvas should build a friendly home card');
assert.ok(canvas.includes('OWNER_ACTIONS'), 'canvas should expose owner action suggestions');
assert.ok(canvas.includes('smarterFallbackCard'), 'canvas should avoid dead end unknown responses');

assert.ok(renderer.includes("case 'business_copilot_home'"), 'renderer should support copilot home card');
assert.ok(renderer.includes('cp-suggestions'), 'renderer should show suggestion actions');
assert.ok(css.includes('.cp-suggest'), 'UI polish should style smart chat suggestions');

console.log('Smart chat: ALL PASSED');
