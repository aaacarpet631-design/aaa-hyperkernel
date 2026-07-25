/* Offline unit tests for the PDP shell's pure logic — byte parity with the
 * canonical files, artifact integrity, fail-closed claims handling, the C4
 * origin backstop at the server boundary, and shadow-vs-enforce behavior. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

let pass = 0, fail = 0;
const ok = (n, c) => c ? pass++ : (fail++, console.log('FAIL:', n));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const ROOT = path.join(__dirname, '..', '..');

// ===== byte parity: the deploy bundle carries EXACT copies of the canonical files =====
ok('bundled artifact is byte-identical to schemas/governance-policy-v1.json',
  sha(lib.ARTIFACT_PATH) === sha(path.join(ROOT, 'schemas', 'governance-policy-v1.json')));
ok('bundled MANIFEST is byte-identical to schemas/governance-policy.MANIFEST.json',
  sha(lib.MANIFEST_PATH) === sha(path.join(ROOT, 'schemas', 'governance-policy.MANIFEST.json')));
ok('bundled decision core is byte-identical to js/core/aaa-policy-decision.js',
  sha(lib.CORE_PATH) === sha(path.join(ROOT, 'js', 'core', 'aaa-policy-decision.js')));

// ===== integrity-verified load =====
const artifact = lib.loadVerifiedArtifact();
ok('artifact loads with verified sha256 and version 1.0', artifact.version === '1.0');
const gates = artifact.hyperkernel.actionGates;
ok('artifact carries the full action table', Object.keys(gates).length >= 30);

// ===== the canonical core loads in an isolated Node context =====
const pdp = lib.createPdp();
ok('createPdp exposes decide/originOf/shadowCompare',
  typeof pdp.decide === 'function' && typeof pdp.originOf === 'function' && typeof pdp.shadowCompare === 'function');

// ===== golden fidelity vs an independent read of the artifact =====
function expected(action, origin, role) {
  const gate = gates[action];
  if (!gate) return 'deny';
  if (origin === 'ai' && gate.aiAllowed !== true) return 'deny';
  if (gate.permission) {
    const perms = artifact.hyperkernel.rbac.roles[role];
    if (!perms || perms.indexOf(gate.permission) === -1) return 'deny';
  }
  return 'allow';
}
let checks = 0, mismatches = 0;
Object.keys(gates).forEach((action) => {
  [['human', 'human'], ['agent', 'ai']].forEach(([principalType, origin]) => {
    Object.keys(artifact.hyperkernel.rbac.roles).forEach((role) => {
      checks++;
      const got = pdp.decide({ action, principalType, role });
      if ((got.allow ? 'allow' : 'deny') !== expected(action, origin, role)) mismatches++;
    });
  });
});
ok('shell decide() matches the artifact for all ' + checks + ' action x origin x role cases', checks > 0 && mismatches === 0);

// ===== handleAuthorize: fail closed =====
const H = lib.handleAuthorize;
ok('no verified claims => 401 UNAUTHENTICATED (never a default role)',
  H({ claims: null, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' }).status === 401);
ok('incomplete claims (no role) => 403 MISSING_CLAIMS',
  H({ claims: { principalType: 'human', workspaceId: 'w1' }, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' }).json.error === 'MISSING_CLAIMS');
ok('incomplete claims (no workspaceId) => 403 MISSING_CLAIMS',
  H({ claims: { principalType: 'human', role: 'owner' }, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' }).json.error === 'MISSING_CLAIMS');
ok('missing action => 400 NO_ACTION',
  H({ claims: { principalType: 'human', role: 'owner', workspaceId: 'w1' }, body: {}, mode: 'enforce' }).json.error === 'NO_ACTION');

// ===== C4 origin backstop at the server boundary =====
const agentClaims = { principalType: 'agent', role: 'owner', workspaceId: 'w1' };
const humanClaims = { principalType: 'human', role: 'owner', workspaceId: 'w1' };
const agentDeny = H({ claims: agentClaims, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' });
ok('enforce: agent credential denied FINALIZE_PRICE even with owner role',
  agentDeny.status === 403 && agentDeny.json.error === 'AI_NOT_PERMITTED');
const smuggled = H({ claims: agentClaims, body: { action: 'FINALIZE_PRICE', principalType: 'human', role: 'owner', origin: 'human' }, mode: 'enforce' });
ok('enforce: body-smuggled principalType/role/origin are ignored — claims win',
  smuggled.status === 403 && smuggled.json.error === 'AI_NOT_PERMITTED');
const humanAllow = H({ claims: humanClaims, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' });
ok('enforce: human owner allowed FINALIZE_PRICE', humanAllow.status === 200 && humanAllow.json.decision.allow === true);
const crewDeny = H({ claims: { principalType: 'human', role: 'crew', workspaceId: 'w1' }, body: { action: 'RUN_MODEL' }, mode: 'enforce' });
ok('enforce: crew denied RUN_MODEL — FORBIDDEN', crewDeny.status === 403 && crewDeny.json.error === 'FORBIDDEN');
ok('enforce: unknown action denied', H({ claims: humanClaims, body: { action: 'HACK_THE_PLANET' }, mode: 'enforce' }).json.error === 'UNKNOWN_ACTION');
ok('enforce: unknown role denied', H({ claims: { principalType: 'human', role: 'intruder', workspaceId: 'w1' }, body: { action: 'FINALIZE_PRICE' }, mode: 'enforce' }).json.error === 'UNKNOWN_ROLE');

// ===== shadow mode: STEP-1 rollout blocks nothing, surfaces divergence =====
const shadowDeny = H({ claims: agentClaims, body: { action: 'FINALIZE_PRICE', clientAllow: true } }); // default mode = shadow
ok('shadow is the DEFAULT mode and never blocks (200 even on a PDP deny)',
  shadowDeny.status === 200 && shadowDeny.json.enforced === false);
ok('shadow flags a client that allowed what the PDP denies',
  shadowDeny.json.shadow.match === false && shadowDeny.json.shadow.pdpAllow === false && shadowDeny.json.shadow.clientAllow === true);
const shadowAgree = H({ claims: agentClaims, body: { action: 'FINALIZE_PRICE', clientAllow: false } });
ok('shadow reports match when client and PDP agree', shadowAgree.json.shadow.match === true);
ok('unrecognized mode value falls back to shadow (never accidentally enforcing)',
  H({ claims: agentClaims, body: { action: 'FINALIZE_PRICE' }, mode: 'blocc' }).json.mode === 'shadow');
ok('workspaceId is echoed from CLAIMS, not the body',
  H({ claims: humanClaims, body: { action: 'FINALIZE_PRICE', workspaceId: 'evil' } , mode: 'enforce' }).json.workspaceId === 'w1');

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
