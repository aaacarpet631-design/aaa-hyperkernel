/* Tenant Guard — the workspace boundary as policy, not just a filter.
 *
 * Guards the honest contract: same-tenant and legacy-untagged records pass,
 * a present-but-different workspaceId is always refused, violations are
 * named individually, and the deep context scan catches a foreign tenant id
 * buried anywhere in a mission context — before any model sees it. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('tenant-guard');
  const { G, cfg } = setupEnv(); // workspaceId: ws_test
  load('js/core/tenant-guard.js');
  const TG = G.AAA_TENANT_GUARD;

  t.eq('active tenant reads config', TG.activeTenant(), 'ws_test');

  // ===== single record =====
  t.ok('same-tenant record passes', TG.checkRecord({ id: 'a', workspaceId: 'ws_test' }).ok === true);
  t.ok('legacy untagged record passes (grandfathered like every store)', TG.checkRecord({ id: 'b' }).ok === true);
  const x = TG.checkRecord({ id: 'c', workspaceId: 'ws_other' });
  t.ok('foreign record refused with both tenants named', x.ok === false && x.error === 'TENANT_BOUNDARY' && x.workspaceId === 'ws_other' && x.active === 'ws_test');
  t.ok('null record is a no-op pass', TG.checkRecord(null).ok === true);

  // ===== batches name every violator =====
  const batch = TG.checkRecords([
    { id: 'r1', workspaceId: 'ws_test' }, { id: 'r2', workspaceId: 'ws_evil' },
    { id: 'r3' }, { id: 'r4', workspaceId: 'ws_other' }
  ]);
  t.ok('both violators named with indices', batch.ok === false && batch.violations.length === 2 && batch.violations[0].id === 'r2' && batch.violations[1].index === 3);
  t.ok('clean batch passes with count', TG.checkRecords([{ id: 'r1' }]).ok === true);

  // ===== deep context scan =====
  t.ok('clean context passes', TG.guardContext({ market: 'DE', quote: { total: 900 } }).ok === true);
  const deep = TG.guardContext({ job: { customer: { history: [{ workspaceId: 'ws_other', note: 'competitor tenant data' }] } } });
  t.ok('foreign tenant id buried 4 levels deep is caught with its path', deep.ok === false && deep.foreign[0].path.indexOf('job.customer.history[0]') === 0);
  t.ok('own workspaceId in context is fine', TG.guardContext({ workspaceId: 'ws_test' }).ok === true);
  t.ok('null context passes', TG.guardContext(null).ok === true);

  // ===== the boundary follows the ACTIVE workspace =====
  cfg.set({ workspaceId: 'ws_other' });
  t.ok('after switching workspace, ws_other records pass', TG.checkRecord({ workspaceId: 'ws_other' }).ok === true);
  t.ok('and ws_test records are now foreign', TG.checkRecord({ workspaceId: 'ws_test' }).ok === false);
  cfg.set({ workspaceId: 'ws_test' });

  return t.report();
};
