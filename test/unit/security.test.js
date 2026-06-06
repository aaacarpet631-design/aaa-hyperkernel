/* Security Hardening — TOTP/MFA, sessions, step-up, approval signatures, immutable audit chain. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('security');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/aaa-security.js');
  const SEC = G.AAA_SECURITY;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== real MFA crypto: RFC 6238 TOTP test vector (SHA-1) =====
  // Secret ASCII "12345678901234567890" → base32 below; T=59, step 30, 8 digits → 94287082.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const code59 = await SEC._totp(RFC_SECRET, { time: 59, step: 30, digits: 8 });
  t.eq('TOTP matches the RFC 6238 vector (proves real HMAC-SHA1)', code59, '94287082');
  const code1111111109 = await SEC._totp(RFC_SECRET, { time: 1111111109, step: 30, digits: 8 });
  t.eq('TOTP second RFC vector', code1111111109, '07081804');

  // ===== non-breaking baseline: enforcement OFF → gateway unchanged =====
  const offRun = await GW.run({ action: 'APPROVE_PAYMENT', actor: 'owner', mutate: async () => 'paid' });
  t.ok('privileged action allowed when hardening is OFF (baseline)', offRun.ok === true && offRun.result === 'paid');

  // ===== audit chain seals automatically once the module is present =====
  const chain0 = await SEC.verifyAuditChain();
  t.ok('audit entries are hash-chained + intact', chain0.ok === true && chain0.length >= 1 && chain0.breaks.length === 0);
  t.ok('privileged allowed action carries an approval signature', (await SEC.approvals()).some((a) => a.action === 'APPROVE_PAYMENT' && !!a.approvalSig));

  // ===== tamper detection: editing a sealed entry breaks the chain =====
  const entries = (await data.list('audit_log')).sort((a, b) => a.seq - b.seq);
  const victim = entries[0];
  await data.put('audit_log', victim.id, Object.assign({}, victim, { action: 'HACKED_ACTION' }));
  const broken = await SEC.verifyAuditChain();
  t.ok('tampering an audit entry is detected', broken.ok === false && broken.breaks.some((b) => b.reason === 'hash_mismatch'));
  await data.put('audit_log', victim.id, victim); // restore

  // ===== sessions: start, validate, expiry, device + role-binding tamper =====
  const start = await SEC.startSession({ actor: 'owner', role: 'owner', deviceId: 'devA' });
  t.ok('session starts with a signed role binding', start.ok === true && !!start.session.roleSig);
  t.ok('valid session validates', (await SEC.validateSession({ deviceId: 'devA' })).ok === true);
  t.eq('device mismatch is rejected', (await SEC.validateSession({ deviceId: 'devB' })).reason, 'DEVICE_MISMATCH');
  // tamper the stored role without re-signing → binding check fails
  const sess = await SEC.currentSession();
  await data.put('security_sessions', sess.id, Object.assign({}, sess, { role: 'crew' }));
  t.eq('role-binding tamper is detected', (await SEC.validateSession()).reason, 'ROLE_BINDING_TAMPERED');
  await data.put('security_sessions', sess.id, sess); // restore
  // expired session
  await SEC.startSession({ actor: 'owner', role: 'owner', deviceId: 'devA', ttlMs: -1000 });
  t.eq('expired session is rejected', (await SEC.validateSession()).reason, 'EXPIRED');
  // fresh valid session for the rest
  await SEC.startSession({ actor: 'owner', role: 'owner', deviceId: 'devA' });

  // ===== configure step-up (PIN) + enable enforcement (owner-only, audited) =====
  const conf = await SEC.configure({ pin: '4731', actor: 'owner' });
  t.ok('owner configures a step-up PIN', conf.ok === true && conf.pinConfigured === true);
  const enf = await SEC.setEnforce(true, { actor: 'owner' });
  t.ok('owner enables enforcement', enf.ok === true && enf.enforce === true);

  // ===== gateway enforcement: privileged needs a fresh step-up =====
  RB.setRole('owner');
  const blocked = await GW.run({ action: 'APPROVE_PAYMENT', actor: 'owner', mutate: async () => 'paid' });
  t.eq('privileged action blocked without step-up', blocked.error, 'STEP_UP_REQUIRED');
  t.ok('non-privileged action still allowed (only privileged need step-up)', (await GW.run({ action: 'ADD_ESTIMATE', actor: 'owner', mutate: async () => 'ok' })).ok === true);

  // bad PIN rejected, good PIN grants step-up
  t.eq('wrong PIN is rejected', (await SEC.verifyStepUp({ pin: '0000' })).error, 'BAD_FACTOR');
  const up = await SEC.verifyStepUp({ pin: '4731' });
  t.ok('correct PIN grants a step-up', up.ok === true && !!up.stepUpExpiresAt && (await SEC.stepUpValid()) === true);
  const allowed = await GW.run({ action: 'APPROVE_PAYMENT', actor: 'owner', mutate: async () => 'paid' });
  t.ok('privileged action allowed after step-up', allowed.ok === true && allowed.result === 'paid');

  // ===== session invalid (e.g. ended) blocks privileged actions =====
  await SEC.endSession();
  t.eq('privileged action blocked when no valid session', (await GW.run({ action: 'APPROVE_PAYMENT', actor: 'owner', mutate: async () => 'x' })).error, 'SESSION_INVALID');
  await SEC.startSession({ actor: 'owner', role: 'owner', deviceId: 'devA' });
  await SEC.verifyStepUp({ pin: '4731' });

  // ===== role binding: live role drift from the signed session is caught =====
  RB.setRole('manager');
  t.eq('verifyRoleBinding catches a role drift', (await SEC.verifyRoleBinding()).reason, 'ROLE_MISMATCH');
  RB.setRole('owner');

  // ===== access control: AI + non-owner cannot administer security =====
  t.eq('AI cannot administer security', (await SEC.configure({ pin: '1', origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('manager');
  t.eq('manager cannot administer security (owner-only)', (await SEC.configure({ pin: '1', actor: 'mgr' })).error, 'FORBIDDEN');
  RB.setRole('owner');

  // every security admin attempt is audited + the whole chain re-verifies clean
  const audit = await GW.recentAudit(300);
  t.ok('security admin actions are audited (MANAGE_SECURITY)', audit.some((a) => a.action === 'MANAGE_SECURITY' && a.decision === 'allowed') && audit.some((a) => a.action === 'MANAGE_SECURITY' && a.decision === 'denied'));
  const finalChain = await SEC.verifyAuditChain();
  t.ok('audit chain remains intact after all activity', finalChain.ok === true && finalChain.breaks.length === 0);

  return t.report();
};
