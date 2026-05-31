/*
 * Tiny zero-dependency test harness for the AAA HyperKernel browser modules.
 *
 * The app's modules are browser globals defined via an IIFE that attaches to
 * `window` (or `this`). To exercise them under Node we set up a minimal global
 * environment (window, crypto, fetch stub), provide in-memory fakes for the
 * cross-cutting singletons (AAA_CONFIG, AAA_DATA, clock, ids, events), then
 * `require` the real source files. No mocking frameworks, no deps.
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
function srcPath(rel) { return path.join(ROOT, rel); }

// ---- assertions ------------------------------------------------------------
function makeRunner(name) {
  let pass = 0, fail = 0; const failures = [];
  function ok(label, cond) { if (cond) pass++; else { fail++; failures.push(label); } }
  function eq(label, a, b) { ok(label + ' (got ' + JSON.stringify(a) + ')', a === b); }
  function report() {
    const line = '[' + name + '] ' + pass + ' passed, ' + fail + ' failed';
    console.log(line);
    failures.forEach((f) => console.log('   FAIL: ' + f));
    return { name: name, pass: pass, fail: fail, failures: failures };
  }
  return { ok: ok, eq: eq, report: report };
}

// ---- in-memory fakes -------------------------------------------------------
function makeConfig(initial) {
  let ov = Object.assign({ workspaceId: 'ws_test', businessName: 'AAA Carpet' }, initial || {});
  return {
    flag: (k, d) => (ov[k] != null ? ov[k] : d),
    set: (p) => { ov = Object.assign({}, ov, p); },
    get workspaceId() { return ov.workspaceId; },
    get businessName() { return ov.businessName; },
    _all: () => ov
  };
}

function makeData() {
  const store = {};
  const col = (c) => (store[c] = store[c] || {});
  return {
    _store: store,
    async put(c, id, v) { col(c)[id] = v; return v; },
    async get(c, id) { return col(c)[id] || null; },
    async list(c) { return Object.values(col(c)); },
    async listJobs() { return Object.values(col('jobs')); },
    async listCustomers() { return Object.values(col('customers')); },
    logAgent(agent, message, context) { col('agent_logs')['l_' + Math.random().toString(36).slice(2)] = { agent, message, context, createdAt: Date.now() }; return {}; },
    cloudReady: () => false
  };
}

let _seq = 0;
function makeIds() { return { createId: (p) => p + '_' + (++_seq) + '_' + Math.random().toString(36).slice(2, 7), newId: () => 'id_' + (++_seq) }; }
function makeClock(fixedISO) { return { now: () => (fixedISO ? Date.parse(fixedISO) : Date.now()), nowISO: () => (fixedISO || new Date().toISOString()) }; }
function makeEvents() {
  const h = {};
  return { emit(t, p) { (h[t] || []).forEach((f) => f(p, t)); (h['*'] || []).forEach((f) => f(p, t)); }, on(t, f) { (h[t] = h[t] || []).push(f); } };
}

// Set up the global browser-ish environment. Returns the handles tests use.
function setupEnv(opts) {
  const o = opts || {};
  const G = global;
  G.window = G;
  if (typeof G.URLSearchParams === 'undefined') G.URLSearchParams = require('url').URLSearchParams;
  if (typeof G.crypto === 'undefined') { try { G.crypto = require('crypto').webcrypto; } catch (_) {} }
  const cfg = makeConfig(o.config);
  const data = makeData();
  G.AAA_CONFIG = cfg;
  G.AAA_DATA = data;
  G.AAA_ID_FACTORY = makeIds();
  G.AAA_RUNTIME_CLOCK = makeClock(o.fixedISO);
  G.AAA_EVENTS = makeEvents();
  return { G: G, cfg: cfg, data: data };
}

// require a source module fresh (clears cache so reloads pick up new globals).
function load(rel) {
  const p = srcPath(rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

module.exports = { makeRunner, setupEnv, load, srcPath, ROOT, makeConfig, makeData };
