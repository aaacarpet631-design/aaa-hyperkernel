/*
 * Static integrity — the checks I used to run ad-hoc, now committed:
 *  1. every JS file under js/ and functions/ parses (node --check),
 *  2. every <script src="/js/..."> in index.html resolves to a real file,
 *  3. every '/js/...' entry precached in sw.js resolves to a real file,
 *  4. portal.html exists and references the portal script,
 *  5. the service worker declares a CACHE_NAME version,
 *  6. PRECACHE parity — every script/stylesheet index.html references is
 *     precached (offline-first must cover the whole app, not half of it).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { makeRunner, ROOT } = require('../helpers/harness');

function walk(dir, acc) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, acc);
    else if (f.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

module.exports = function run() {
  const t = makeRunner('integrity');

  // 1. syntax
  const jsFiles = [];
  ['js', 'functions', 'test'].forEach((d) => { const dir = path.join(ROOT, d); if (fs.existsSync(dir)) walk(dir, jsFiles); });
  let bad = 0;
  for (const f of jsFiles) {
    const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; t.ok('syntax ' + path.relative(ROOT, f) + ': ' + (r.stderr || '').split('\n')[0], false); }
  }
  t.ok(jsFiles.length + ' JS files parse', bad === 0);

  // 2 + 3. path integrity
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let missIdx = 0;
  (index.match(/src="\/js\/[^"]+"/g) || []).forEach((m) => { const rel = m.slice(5, -1); if (!fs.existsSync(path.join(ROOT, rel))) { missIdx++; t.ok('index src missing ' + rel, false); } });
  t.ok('all index.html /js srcs resolve', missIdx === 0);

  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  let missSw = 0;
  (sw.match(/'\/js\/[^']+'/g) || []).forEach((m) => { const rel = m.slice(1, -1); if (!fs.existsSync(path.join(ROOT, rel))) { missSw++; t.ok('sw precache missing ' + rel, false); } });
  t.ok('all sw.js /js precache entries resolve', missSw === 0);

  // 4. portal page
  t.ok('portal.html exists', fs.existsSync(path.join(ROOT, 'portal.html')));
  t.ok('portal.html loads portal-app.js', /portal-app\.js/.test(fs.readFileSync(path.join(ROOT, 'portal.html'), 'utf8')));

  // 5. sw version present
  t.ok('sw CACHE_NAME present', /CACHE_NAME\s*=\s*'hyperkernel-v\d+'/.test(sw));

  // 6. PRECACHE parity with index.html (both directions for js/css)
  const preBlock = (sw.match(/const PRECACHE = \[([\s\S]*?)\];/) || ['', ''])[1];
  const precached = new Set((preBlock.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1)));
  const referenced = []
    .concat((index.match(/<script src="([^"]+)"/g) || []).map((s) => s.slice(13, -1)))
    .concat((index.match(/<link rel="stylesheet" href="([^"]+)"/g) || []).map((s) => s.slice(29, -1)));
  let notPre = 0;
  referenced.forEach((rel) => { if (!precached.has(rel)) { notPre++; t.ok('not precached: ' + rel, false); } });
  t.ok('every index.html script/stylesheet is precached (' + referenced.length + ' refs)', notPre === 0);
  let ghost = 0;
  precached.forEach((p) => {
    if ((p.endsWith('.js') || p.endsWith('.css')) && referenced.indexOf(p) === -1) { ghost++; t.ok('precached but not referenced by index.html: ' + p, false); }
  });
  t.ok('no ghost js/css precache entries', ghost === 0);

  return t.report();
};
