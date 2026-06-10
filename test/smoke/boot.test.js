/*
 * Boot smoke test — loads every script index.html references, in order, into a
 * simulated browser global, and asserts the app's core/logic modules define
 * themselves without throwing.
 *
 * It does NOT render DOM (that needs Playwright — see README), but it catches
 * the most common real breakage: a script that throws at load, a missing
 * global, or a load-order bug where module B needs module A that loads later.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeRunner, ROOT } = require('../helpers/harness');

function makeWindow() {
  const noop = function () {};
  const el = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, removeChild: noop, append: noop, prepend: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop, insertBefore: noop,
    getContext: () => ({ fillRect: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop }),
    querySelector: () => null, querySelectorAll: () => [], cloneNode: el,
    setProperty: noop, focus: noop, click: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    children: [], childNodes: [], firstChild: null, parentNode: null, innerHTML: '', textContent: ''
  });
  const win = {};
  win.window = win;
  win.document = {
    createElement: el, createElementNS: el, createTextNode: () => ({}),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    documentElement: el(), body: el(), head: el(), cookie: '', readyState: 'complete'
  };
  win.navigator = { userAgent: 'node', onLine: true, serviceWorker: { register: () => Promise.resolve() }, share: undefined, clipboard: { writeText: () => Promise.resolve() } };
  win.localStorage = (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, clear: () => { Object.keys(m).forEach((k) => delete m[k]); } }; })();
  win.indexedDB = { open: () => ({ addEventListener: noop, result: null }) };
  win.location = { origin: 'https://test', href: 'https://test/', pathname: '/', search: '', hostname: 'test', protocol: 'https:' };
  win.history = { replaceState: noop, pushState: noop };
  win.addEventListener = noop; win.removeEventListener = noop;
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout; win.setInterval = () => 0; win.clearInterval = noop;
  win.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  win.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
  win.crypto = (global.crypto || { getRandomValues: (a) => a, randomUUID: () => 'x' });
  win.URL = require('url').URL; win.URLSearchParams = require('url').URLSearchParams;
  win.console = console;
  return win;
}

function scriptList() {
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...index.matchAll(/src="(\/[^"]+\.js)"/g)].map((m) => m[1].replace(/^\//, ''));
}

module.exports = function run() {
  const t = makeRunner('boot-smoke');
  const win = makeWindow();
  const ctx = vm.createContext(win);

  const scripts = scriptList();
  let loaded = 0, threw = null, threwAt = null;
  for (const rel of scripts) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { t.ok('script exists ' + rel, false); continue; }
    try {
      // Browsers give each <script> its own top-level scope: top-level
      // const/let in one file don't collide with another's. A shared vm context
      // does NOT do that, so wrap each file in its own function scope (still
      // sharing the same global object, exactly like real <script> tags).
      vm.runInContext('(function(){\n' + fs.readFileSync(p, 'utf8') + '\n})();', ctx, { filename: rel });
      loaded++;
    } catch (e) {
      threw = e; threwAt = rel; break;
    }
  }
  t.ok('all ' + scripts.length + ' scripts loaded without throwing' + (threwAt ? ' (failed at ' + threwAt + ': ' + (threw && threw.message) + ')' : ''), threw === null && loaded === scripts.length);

  // Core + data + business-logic singletons must exist after the full load.
  // (Deep UI-module globals depend on a real DOM and ordered <script> isolation
  // a headless shim can't fully reproduce — those are covered by the Playwright
  // render test, tracked as a follow-up in test/README.md. The "loaded without
  // throwing" check above is what catches load-time crashes and load-order
  // bugs across all UI scripts.)
  ['AAA_CONFIG', 'AAA_RBAC', 'AAA_RUNTIME_GATEWAY', 'AAA_EVENTS',
    'AAA_MEASUREMENT_QUOTE', 'AAA_ACCOUNTING', 'AAA_CONTRACTS', 'AAA_SCHEDULING',
    'AAA_CREW_STORE', 'AAA_TOOL_STORE', 'AAA_PORTAL_LINKS', 'AAA_QUICKBOOKS_ONLINE',
    'AAA_UI', 'AAA_BUSINESS', 'AAA_LEADS', 'AAA_PRICE_BOOK'].forEach((g) => {
    t.ok('global defined: ' + g, typeof win[g] !== 'undefined');
  });

  return t.report();
};
