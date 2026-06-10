/*
 * Supabase governance REST shapes (stubbed fetch — no network).
 * Verifies upsertGovernance posts to the governance_store table with the right
 * conflict key + body, the ledger uses ignore-duplicates (append-only), and
 * listGovernance maps rows back to records.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('supabase-governance');
  const { G } = setupEnv({});
  G.AAA_CONFIG.supabaseUrl = 'https://demo.supabase.co';
  G.AAA_CONFIG.supabaseAnonKey = 'anon_key';
  load('js/core/aaa-supabase.js');
  const SB = G.AAA_SUPABASE;

  let calls = [];
  G.fetch = async function (url, options) {
    calls.push({ url: url, method: options.method, headers: options.headers, body: options.body });
    if (options.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify([{ doc_id: 'estimator', data: { accuracy: 0.9 } }]) };
    return { ok: true, status: 200, text: async () => '' };
  };

  // ---- upsert a mutable governance record (merge-duplicates) -------------
  await SB.upsertGovernance('gov_agent_scorecards', 'estimator', { accuracy: 0.9 });
  const up = calls[0];
  t.ok('posts to governance_store with conflict key', /\/rest\/v1\/governance_store\?on_conflict=workspace_id,collection,doc_id$/.test(up.url) && up.method === 'POST');
  t.ok('merge-duplicates for mutable records', /resolution=merge-duplicates/.test(up.headers.Prefer));
  const row = JSON.parse(up.body)[0];
  t.ok('row carries ws/collection/doc_id/data', row.workspace_id === 'ws_test' && row.collection === 'gov_agent_scorecards' && row.doc_id === 'estimator' && row.data.accuracy === 0.9);

  // ---- ledger uses ignore-duplicates (append-only) ----------------------
  await SB.upsertGovernance('governance_audit', 'a1', { id: 'a1', type: 'flagged' });
  t.ok('ledger upsert ignores duplicates', /resolution=ignore-duplicates/.test(calls[1].headers.Prefer));

  // ---- listGovernance maps rows back ------------------------------------
  const list = await SB.listGovernance('gov_agent_scorecards');
  const getCall = calls[2];
  t.ok('selects doc_id+data filtered by collection + workspace', /select=doc_id,data/.test(getCall.url) && /collection=eq\.gov_agent_scorecards/.test(getCall.url) && /workspace_id=eq\.ws_test/.test(getCall.url));
  t.ok('rows mapped to records with _id', list.ok === true && list.items[0]._id === 'estimator' && list.items[0].accuracy === 0.9);

  return t.report();
};
