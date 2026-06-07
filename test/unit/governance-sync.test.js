/*
 * Governance cloud persistence (no real network — mock cloud).
 * Verifies: governance writes auto-mirror to the cloud, push mirrors all local
 * records, pull hydrates cloud records into local storage (without re-uploading),
 * non-governance writes are not mirrored, and Supabase is a safe no-op.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
const flush = () => new Promise((r) => setImmediate(r));

function mockCloud(provider) {
  return {
    _up: [], _store: {},
    isConfigured: function () { return true; },
    provider: function () { return provider; },
    async upsertEntity(c, id, e) { this._up.push({ c: c, id: id }); (this._store[c] = this._store[c] || {})[id] = e; return { ok: true }; },
    async listEntities(c) { return provider === 'firebase' ? { ok: true, items: Object.keys(this._store[c] || {}).map((k) => Object.assign({ _id: k }, this._store[c][k])) } : { ok: false, error: 'NOT_SUPPORTED' }; }
  };
}

module.exports = async function run() {
  const t = makeRunner('governance-sync');
  const { G } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1' } });
  // Use the REAL data + storage so the AAA_DATA.put → mirror hook is exercised.
  load('js/core/local-first-storage.js');
  load('js/core/aaa-data.js');
  const cloud = mockCloud('firebase');
  G.AAA_CLOUD = cloud;
  load('js/governance/governance-sync.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/agent-outcomes.js');
  const SYNC = G.AAA_GOVERNANCE_SYNC, O = G.AAA_AGENT_OUTCOMES, DATA = G.AAA_DATA;

  t.ok('ready with firebase + workspace', SYNC.ready() === true);
  t.ok('recognizes governance collections', SYNC.isCollection('gov_agent_decisions') && SYNC.isCollection('governance_audit') && !SYNC.isCollection('customers'));

  // ---- automatic mirroring on a governance write -------------------------
  const dec = (await O.recordDecision({ agentId: 'estimator', agentType: 'estimator', confidence: 0.7, recommendation: 'r', subjectId: 's1', subjectType: 'job' })).decision;
  await flush(); // mirror is fire-and-forget
  t.ok('decision auto-mirrored to cloud', cloud._up.some((u) => u.c === 'gov_agent_decisions' && u.id === dec.decisionId));
  t.ok('ledger entry auto-mirrored', cloud._up.some((u) => u.c === 'governance_audit'));

  // ---- non-governance write is NOT mirrored ------------------------------
  const before = cloud._up.length;
  await DATA.put('customers', 'c1', { id: 'c1', name: 'Jane' });
  await flush();
  t.ok('non-governance write not mirrored', cloud._up.length === before);

  // ---- push: mirror all local governance records -------------------------
  const pushed = await SYNC.push();
  t.ok('push reports a count', pushed.ok === true && pushed.pushed >= 1);

  // ---- pull/hydrate: cloud → local, without re-uploading -----------------
  // seed a record that exists only in the cloud
  cloud._store['gov_improvement_tasks'] = { taskX: { taskId: 'taskX', agentId: 'estimator', issue: 'from cloud', status: 'open' } };
  const upBefore = cloud._up.length;
  const pull = await SYNC.pull();
  t.ok('pull reports a count', pull.ok === true && pull.pulled >= 1);
  const local = await DATA.get('gov_improvement_tasks', 'taskX');
  t.ok('cloud-only record hydrated locally', !!local && local.issue === 'from cloud');
  t.ok('pull did not re-upload (mirror suspended)', cloud._up.length === upBefore);
  t.ok('mirror flag reset after pull', SYNC._suspendMirror === false);

  // ---- Supabase backend is a safe no-op ----------------------------------
  G.AAA_CLOUD = mockCloud('supabase');
  t.ok('not ready on supabase (governance stays local)', SYNC.ready() === false);
  t.eq('mirror no-op on supabase', (await SYNC.mirror('gov_agent_decisions', 'x', {})).error, 'SKIPPED');
  t.eq('push no-op on supabase', (await SYNC.push()).error, 'NOT_READY');

  return t.report();
};
