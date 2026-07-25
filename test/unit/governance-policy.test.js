/* Governance Policy Contract v1 — the shared, versioned policy artifact
 * (ATLAS/LEVIATHAN STEP 0).
 *
 * Guards ZERO behavior change + no drift: the generated
 * schemas/governance-policy-v1.json reproduces the LIVE gateway ACTIONS and
 * RBAC MATRIX bit-for-bit (per-action permission + aiAllowed, so a flipped
 * human-authority bit fails by name); the on-disk artifact matches the
 * module's document() byte-for-byte and its MANIFEST sha256; and the
 * custonllm routePerms mirror is carried for the Python side to conform to. */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { makeRunner, setupEnv, load, srcPath } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance-policy');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/aaa-policy-contract.js');
  const POLICY = G.AAA_POLICY, GW = G.AAA_RUNTIME_GATEWAY, RBAC = G.AAA_RBAC;

  const onDisk = JSON.parse(fs.readFileSync(srcPath('schemas/governance-policy-v1.json'), 'utf8'));
  const doc = POLICY.document();

  // ===== drift guard: the committed artifact IS the module's output =====
  t.ok('schemas/governance-policy-v1.json matches document() byte-for-byte',
    JSON.stringify(onDisk, null, 2) === JSON.stringify(doc, null, 2));
  const manifest = JSON.parse(fs.readFileSync(srcPath('schemas/governance-policy.MANIFEST.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(srcPath('schemas/governance-policy-v1.json'))).digest('hex');
  t.ok('artifact matches its MANIFEST sha256 (cross-repo parity anchor)', manifest['governance-policy-v1.json'] === sha);
  t.eq('version is 1.0', doc.version, '1.0');

  // ===== actionGates reproduce the LIVE gateway ACTIONS, per-action =====
  const gates = doc.hyperkernel.actionGates;
  const actionKeys = Object.keys(GW.ACTIONS);
  t.eq('every gateway action is in the artifact (count)', Object.keys(gates).length, actionKeys.length);
  let fidelity = true;
  actionKeys.forEach(function (a) {
    const live = GW.ACTIONS[a];
    const art = gates[a];
    const permOk = art && art.permission === (live.permission != null ? live.permission : null);
    const aiOk = art && art.aiAllowed === !!live.aiAllowed;
    if (!permOk || !aiOk) { fidelity = false; console.log('   drift on ' + a + ': live=' + JSON.stringify(live) + ' artifact=' + JSON.stringify(art)); }
  });
  t.ok('every action reproduces permission + aiAllowed bit-for-bit', fidelity);

  // ===== human-authority bits are preserved (aiAllowed:false set) =====
  const humanOnly = POLICY.humanOnlyActions();
  const liveHumanOnly = actionKeys.filter(function (a) { return GW.ACTIONS[a].aiAllowed === false; }).sort();
  t.ok('the aiAllowed:false human-authority set matches the live gateway', JSON.stringify(humanOnly) === JSON.stringify(liveHumanOnly));
  ['FINALIZE_PRICE', 'GOVERN_REGISTRY', 'MANAGE_SECURITY', 'ERASE_DATA', 'EXPORT_CONVERSIONS', 'REVIEW_ADS_RECOMMENDATION'].forEach(function (a) {
    t.ok(a + ' stays human-only (aiAllowed:false)', gates[a] && gates[a].aiAllowed === false);
  });
  t.ok('an AI-allowed action stays AI-allowed (RUN_MODEL)', gates.RUN_MODEL && gates.RUN_MODEL.aiAllowed === true);

  // ===== rbac section reproduces the LIVE MATRIX + PERMISSIONS =====
  t.ok('rbac roles match the live MATRIX',
    JSON.stringify(doc.hyperkernel.rbac.roles) === JSON.stringify(Object.keys(RBAC.MATRIX).reduce(function (o, r) { o[r] = RBAC.MATRIX[r].slice(); return o; }, {})));
  t.ok('rbac permission catalog matches live PERMISSIONS keys',
    JSON.stringify(Object.keys(doc.hyperkernel.rbac.permissions).sort()) === JSON.stringify(Object.keys(RBAC.PERMISSIONS).sort()));
  t.ok('owner holds every permission (matrix invariant preserved)',
    doc.hyperkernel.rbac.roles.owner.length === Object.keys(RBAC.PERMISSIONS).length);
  t.ok('crew cannot APPROVE_QUOTE (a real gate survives the extraction)',
    doc.hyperkernel.rbac.roles.crew.indexOf('APPROVE_QUOTE') === -1);

  // ===== custonllm routePerms section is present + sorted (Python conforms) =====
  const rp = doc.custonllm.routePerms;
  t.ok('routePerms carries the 5 custonllm roles', JSON.stringify(Object.keys(rp).sort()) === JSON.stringify(['admin', 'crew', 'customer', 'estimator', 'owner']));
  t.ok('customer route-perms are chat-only (denied copilot)', JSON.stringify(rp.customer) === JSON.stringify(['chat']));
  t.ok('every internal role holds copilot, customer does not',
    rp.owner.indexOf('copilot') !== -1 && rp.estimator.indexOf('copilot') !== -1 && rp.crew.indexOf('copilot') !== -1 && rp.customer.indexOf('copilot') === -1);
  t.ok('routePerms arrays are sorted (deterministic artifact)',
    Object.keys(rp).every(function (role) { return JSON.stringify(rp[role]) === JSON.stringify(rp[role].slice().sort()); }));

  // ===== field set is frozen (no untested drift-bait fields) =====
  t.ok('actionGates carry ONLY permission + aiAllowed (frozen v1 shape)',
    Object.keys(gates).every(function (a) { return JSON.stringify(Object.keys(gates[a]).sort()) === JSON.stringify(['aiAllowed', 'permission']); }));

  return t.report();
};
