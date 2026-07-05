/*
 * Workforce Tick — the server-side runner for the agent workforce.
 *
 * A Netlify SCHEDULED function that drives the exact same module stack the
 * app and the tests run — AAA_WORKFORCE_RUNNER.runTick() — against a shared
 * Netlify Blobs datastore ('hyperkernel-workforce'). The browser is a window
 * onto this state; this function is the liveness.
 *
 * Fail-closed by construction:
 *   - CONTINUOUS_AGENTS_ENABLED env must be exactly 'true' (server-side kill
 *     switch, independent of and in addition to the in-store config flag)
 *   - the runner acquires the persisted tick lease — overlapping invocations
 *     resolve to one executing tick
 *   - no MODEL_PROXY_URL configured → missions fail honestly with
 *     AI_NOT_CONFIGURED; nothing is fabricated
 *   - any thrown error returns { ok:false, error } — never a fake summary
 *
 * Env: CONTINUOUS_AGENTS_ENABLED ('true' to arm), WORKFORCE_WORKSPACE_ID
 * (default 'default'), MODEL_PROXY_URL (the deployed model proxy endpoint;
 * optional), WORKFORCE_MAX_CONCURRENT (default 2). No secrets in this file.
 */
import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STORE_NAME = 'hyperkernel-workforce';

// The stack the app/tests load, in dependency order.
const MODULES = [
  'js/core/aaa-event-bus.js',
  'js/core/country-packs.js',
  'js/core/tenant-guard.js',
  'js/core/aaa-rbac.js',
  'js/governance/audit-ledger.js',
  'js/agents/action-safety-gate.js',
  'js/agents/escalation-policy.js',
  'js/governance/decision-envelope.js',
  'js/ai/tenant-model-policy.js',
  'js/agents/agent-registry.js',
  'js/agents/model-router.js',
  'js/agents/agent-os.js',
  'js/agents/global-desk.js',
  'js/agents/planning-desk.js',
  'js/agents/review-protocol.js',
  'js/agents/mission-manager.js',
  'js/agents/workforce-registry.js',
  'js/agents/workforce-queue.js',
  'js/agents/workforce-scheduler.js',
  'js/agents/workforce-lease.js',
  'js/agents/workforce-runner.js'
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Blobs-backed AAA_DATA: one JSON blob per (workspace, collection) holding an
 * id→record map. Read-through cache per invocation; dirty collections are
 * flushed once after the tick (a crash before flush loses the tick's writes,
 * never corrupts prior state — and the lease takeover audit will show it).
 */
function makeBlobData(store, workspaceId) {
  const cache = new Map();
  const dirty = new Set();
  const key = (collection) => `ws/${workspaceId}/${collection}`;
  async function col(collection) {
    if (!cache.has(collection)) {
      const val = await store.get(key(collection), { type: 'json' });
      cache.set(collection, val && typeof val === 'object' ? val : {});
    }
    return cache.get(collection);
  }
  return {
    async put(collection, id, value) { (await col(collection))[id] = value; dirty.add(collection); return value; },
    async get(collection, id) { const c = await col(collection); return c[id] != null ? c[id] : null; },
    async list(collection) { return Object.values(await col(collection)); },
    logAgent() { return {}; },
    cloudReady() { return false; },
    async flush() {
      for (const collection of dirty) await store.setJSON(key(collection), cache.get(collection));
      const flushed = dirty.size; dirty.clear();
      return flushed;
    },
    callAgent: null // installed below when a proxy is configured
  };
}

function makeConfig(workspaceId, env) {
  const flags = {
    continuousAgentsEnabled: true, // env gate already passed to get here
    workforceMaxConcurrent: Number(env.WORKFORCE_MAX_CONCURRENT) > 0 ? Number(env.WORKFORCE_MAX_CONCURRENT) : 2,
    role: 'owner' // the server runner acts with owner authority; approvals still pause for humans
  };
  return {
    workspaceId,
    businessName: env.BUSINESS_NAME || 'AAA Carpet',
    flag: (k, d) => (k in flags ? flags[k] : d),
    isProxyConfigured: () => Boolean(env.MODEL_PROXY_URL)
  };
}

function installStack(G, data, config) {
  G.window = G;
  G.AAA_CONFIG = config;
  G.AAA_DATA = data;
  let seq = 0;
  G.AAA_ID_FACTORY = { createId: (p) => `${p}_${Date.now().toString(36)}_${(++seq).toString(36)}` };
  G.AAA_RUNTIME_CLOCK = { now: () => Date.now(), nowISO: () => new Date().toISOString() };
  for (const rel of MODULES) require(path.join(ROOT, rel));
}

async function proxyCallAgent(env, payload) {
  const res = await fetch(env.MODEL_PROXY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, error: `PROXY_${res.status}` };
  return res.json();
}

export default async function handler(req) {
  const env = process.env;
  if (env.CONTINUOUS_AGENTS_ENABLED !== 'true') {
    return json({ ok: true, ran: 0, skipped: 'CONTINUOUS_AGENTS_DISABLED', note: 'set CONTINUOUS_AGENTS_ENABLED=true to arm the server runner' });
  }
  const workspaceId = env.WORKFORCE_WORKSPACE_ID || 'default';
  try {
    const store = getStore(STORE_NAME);
    const data = makeBlobData(store, workspaceId);
    const config = makeConfig(workspaceId, env);
    if (config.isProxyConfigured()) data.callAgent = (payload) => proxyCallAgent(env, payload);

    const G = globalThis;
    installStack(G, data, config);

    // Observability: GET returns state, never executes.
    if (req && req.method === 'GET') {
      const agents = await G.AAA_WORKFORCE_REGISTRY.list();
      const jobs = await G.AAA_WORKFORCE_QUEUE.list();
      return json({ ok: true, mode: 'observe', workspaceId, agents: agents.length, enabled: agents.filter((a) => a.enabled).length, jobs: jobs.slice(0, 20) });
    }

    const owner = `netlify:${Date.now().toString(36)}`;
    const result = await G.AAA_WORKFORCE_RUNNER.runTick({ owner });
    const flushed = await data.flush();
    return json({ ok: result.ok !== false, workspaceId, owner, flushedCollections: flushed, result });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// Netlify scheduled function: every 15 minutes. The in-store kill switch and
// the env gate above both still apply — schedule ≠ permission.
export const config = { schedule: '*/15 * * * *' };
