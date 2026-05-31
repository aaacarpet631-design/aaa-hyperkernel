/* Portal links — token lifecycle, expiry, revoke, workspace isolation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('portal-links');
  const { G, cfg } = setupEnv();
  G.location = { origin: 'https://app.example.com' };
  load('js/portal/portal-link-store.js');
  const P = G.AAA_PORTAL_LINKS;
  const contract = { id: 'k1', customerName: 'Jane', jobId: 'j1', customerId: 'c1' };

  const r = await P.create(contract, { expiresInDays: 30 });
  t.ok('create ok + url', r.ok && /portal\.html\?t=/.test(r.url));
  t.ok('token >=40 chars', r.link.id.length >= 40);
  t.ok('url uses origin', r.url.startsWith('https://app.example.com/portal.html?t='));
  t.ok('link live', P.isLive(r.link) === true);
  t.eq('forContract finds it', (await P.forContract('k1')).length, 1);

  await P.revoke(r.link.id);
  t.ok('revoked => not live', P.isLive(await P.get(r.link.id)) === false);

  const exp = await P.create(contract, { expiresInDays: -1 });
  t.ok('expired (-1) not live', P.isLive(exp.link) === false && exp.link.expiresAt != null);
  const never = await P.create(contract, { expiresInDays: 0 });
  t.ok('0 days = never expires', never.link.expiresAt === null && P.isLive(never.link) === true);

  cfg.set({ portalBaseUrl: 'https://aaacarpet.com/' });
  t.eq('custom base trims slash', P.urlFor('TOK'), 'https://aaacarpet.com/portal.html?t=TOK');

  cfg.set({ workspaceId: 'ws_other' });
  t.ok('workspace isolation', (await P.get(r.link.id)) === null);

  return t.report();
};
