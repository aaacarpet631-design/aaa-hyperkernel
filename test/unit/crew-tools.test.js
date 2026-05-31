/* Crew + tool lifecycle — check-out/in/maintenance + productivity. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('crew-tools');
  const { G, data } = setupEnv();
  load('js/crew/crew-store.js');
  load('js/crew/tool-store.js');
  const C = G.AAA_CREW_STORE, T = G.AAA_TOOL_STORE;

  const joe = await C.add({ name: 'Joe', role: 'installer' });
  t.eq('crew added', (await C.list()).length, 1);

  const kicker = await T.add({ name: 'Crain Knee Kicker', category: 'Stretching' });
  t.eq('tool available', kicker.status, 'available');
  const co = await T.checkOut(kicker.id, joe.id, joe.name);
  t.ok('checked out to Joe', co.ok && co.tool.status === 'checked_out' && co.tool.heldByName === 'Joe');
  t.ok('cannot double check-out', (await T.checkOut(kicker.id, joe.id, joe.name)).error === 'ALREADY_OUT');
  const ci = await T.checkIn(kicker.id, 'ok', { damaged: true });
  t.ok('returned damaged + history', ci.ok && ci.tool.status === 'damaged' && ci.tool.history.length === 2);
  t.eq('repaired -> available', (await T.setMaintenance(kicker.id, false)).tool.status, 'available');
  const sm = await T.summary();
  t.ok('summary counts', sm.total === 1 && sm.byStatus.available === 1);

  data._store.jobs = {
    j1: { id: 'j1', assigneeIds: [joe.id], currentState: 'CLOSED' },
    j2: { id: 'j2', assigneeIds: [joe.id], currentState: 'IN_PROGRESS' }
  };
  const prod = await C.productivity();
  t.ok('productivity 2 assigned 1 done 50%', prod[0].assigned === 2 && prod[0].completed === 1 && prod[0].completionRate === 50);

  return t.report();
};
