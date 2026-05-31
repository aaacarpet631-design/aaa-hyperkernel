/* QuickBooks Online client — proxy-routed, no tokens in browser, approval-gated. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('quickbooks-online');
  const { G, cfg } = setupEnv();
  const proxyCalls = [];
  G.fetch = async (url, opts) => { proxyCalls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return { json: async () => ({ ok: true, connected: true, realmId: 'R1', Id: 'QBO99' }) }; };
  G.AAA_FIREBASE = { idToken: 'IDTOK' };
  G.AAA_ACCOUNTING = { async listInvoices() { return [{ id: 'i1', customerName: 'Jane', issuedAt: '2026-06-01T00:00:00Z', amount: 1200, items: [{ description: 'Install', amount: 1000 }, { description: 'Pad', amount: 200 }] }]; } };
  load('js/accounting/quickbooks-online.js');
  const Q = G.AAA_QUICKBOOKS_ONLINE;

  t.ok('not configured initially', Q.status().configured === false);
  t.ok('authUrl NOT_CONFIGURED', Q.authUrl().error === 'NOT_CONFIGURED');
  t.ok('push NOT_CONFIGURED', (await Q.pushInvoice('i1', true)).error === 'NOT_CONFIGURED');

  cfg.set({ qboClientId: 'CID', qboRedirectUri: 'https://app/cb', qboProxyUrl: 'https://fn/qbo' });
  t.ok('configured, not connected', Q.status().configured === true && Q.status().connected === false);
  const au = Q.authUrl('s');
  t.ok('authUrl scope + ws state', au.ok && /com\.intuit\.quickbooks\.accounting/.test(au.url) && /state=s%3Aws_test/.test(au.url));
  t.ok('push NOT_CONNECTED before connect', (await Q.pushInvoice('i1', true)).error === 'NOT_CONNECTED');

  const c = await Q.connect('CODE', 'R1');
  t.ok('connect ok + cached flag', c.ok && Q.status().connected === true);
  t.ok('connect carried code+ws+bearer', proxyCalls.some((p) => p.body.action === 'exchange' && p.body.code === 'CODE' && p.body.workspaceId === 'ws_test' && p.auth === 'Bearer IDTOK'));

  const m = Q.mapInvoice({ id: 'i1', customerName: 'Jane', amount: 1200, items: [{ description: 'Install', amount: 1000 }, { description: 'Pad', amount: 200 }] });
  t.ok('mapInvoice shape', m.TotalAmt === 1200 && m.Line.length === 2 && m._sourceId === 'i1');

  t.ok('push APPROVAL_REQUIRED', (await Q.pushInvoice('i1')).error === 'APPROVAL_REQUIRED');
  const pr = await Q.pushInvoice('i1', true);
  t.ok('push ok with approval', pr.ok === true && pr.Id === 'QBO99');
  t.ok('proxy createInvoice approved:true', proxyCalls.some((p) => p.body.action === 'createInvoice' && p.body.approved === true));
  t.eq('pushAll count', (await Q.pushAllInvoices(true)).pushed, 1);

  return t.report();
};
