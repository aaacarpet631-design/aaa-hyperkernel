/* Runtime Gateway — AI hard-block, RBAC enforcement, audit logging. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gateway');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  const GW = G.AAA_RUNTIME_GATEWAY, R = G.AAA_RBAC;

  const aiPrice = await GW.run({ action: 'FINALIZE_PRICE', origin: 'ai', actor: 'sales' });
  t.ok('AI blocked from FINALIZE_PRICE', aiPrice.ok === false && aiPrice.error === 'AI_NOT_PERMITTED');
  t.ok('AI blocked from CLOSE_JOB', (await GW.run({ action: 'CLOSE_JOB', origin: 'ai' })).ok === false);
  t.ok('AI blocked from MODIFY_ACCOUNTING', (await GW.run({ action: 'MODIFY_ACCOUNTING', origin: 'ai' })).ok === false);
  t.ok('unknown action denied', (await GW.run({ action: 'NOPE', origin: 'ai' })).ok === false);

  R.setRole('owner');
  let ran = false;
  const ownerPrice = await GW.run({ action: 'FINALIZE_PRICE', origin: 'human', mutate: async () => { ran = true; return 'priced'; } });
  t.ok('owner CAN finalize + mutate ran', ownerPrice.ok === true && ran === true && ownerPrice.result === 'priced');

  R.setRole('crew');
  let crewRan = false;
  const crewClose = await GW.run({ action: 'CLOSE_JOB', origin: 'human', mutate: async () => { crewRan = true; } });
  t.ok('crew blocked from CLOSE_JOB (FORBIDDEN)', crewClose.ok === false && crewClose.error === 'FORBIDDEN' && crewRan === false);

  const log = await GW.recentAudit(50);
  t.ok('audit recorded attempts', log.length >= 5);
  t.ok('audit has denied AI entry', log.some((e) => e.origin === 'ai' && e.decision === 'denied'));
  t.ok('audit has allowed owner FINALIZE_PRICE', log.some((e) => e.decision === 'allowed' && e.action === 'FINALIZE_PRICE'));
  t.ok('audit has crew FORBIDDEN', log.some((e) => e.decision === 'denied' && e.reason === 'FORBIDDEN'));

  R.setRole('owner');
  let mutations = 0;
  const mutate = () => { mutations++; };
  for (const action of ['__proto__', 'constructor', 'toString']) {
    t.eq('inherited action ' + action + ' rejected', (await GW.run({ action, mutate })).error, 'UNKNOWN_ACTION');
  }
  delete G.AAA_RBAC;
  t.eq('missing role module fails closed', (await GW.run({ action: 'FINALIZE_PRICE', mutate })).error, 'FORBIDDEN');
  t.eq('missing role cannot enable UI action', GW.canHuman('FINALIZE_PRICE'), false);
  G.AAA_RBAC = { can() { throw new Error('failed'); }, role() { throw new Error('failed'); } };
  t.eq('broken role module fails closed', (await GW.run({ action: 'FINALIZE_PRICE', mutate })).error, 'FORBIDDEN');
  G.AAA_RBAC = R;
  for (const gateCheck of [async () => { throw Error('unavailable'); }, async () => null, async () => ({}), async () => ({ allow: 'yes' })]) {
    G.AAA_SECURITY = { gateCheck };
    t.eq('security must explicitly permit the action', (await GW.run({ action: 'FINALIZE_PRICE', mutate })).ok, false);
  }
  delete G.AAA_SECURITY;
  const originalPut = G.AAA_DATA.put;
  G.AAA_DATA.put = async () => { throw Error('quota'); };
  t.eq('failed local audit prevents the mutation', (await GW.run({ action: 'FINALIZE_PRICE', mutate })).error, 'AUDIT_UNAVAILABLE');
  G.AAA_DATA.put = originalPut;
  t.eq('no disallowed mutation ran', mutations, 0);

  return t.report();
};
