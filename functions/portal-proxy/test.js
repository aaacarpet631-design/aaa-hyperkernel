/* Offline unit tests for the portal proxy's pure logic (redaction + lifecycle). */
'use strict';
const { linkLive, publicContract, publicInvoice, buildView } = require('./lib');

let pass = 0, fail = 0;
const ok = (n, c) => c ? pass++ : (fail++, console.log('FAIL:', n));

// linkLive
ok('live link', linkLive({ revoked: false, expiresAt: new Date(Date.now() + 1000).toISOString() }) === true);
ok('revoked dead', linkLive({ revoked: true }) === false);
ok('expired dead', linkLive({ revoked: false, expiresAt: new Date(Date.now() - 1000).toISOString() }) === false);
ok('no-expiry live', linkLive({ revoked: false, expiresAt: null }) === true);
ok('null dead', linkLive(null) === false);

// publicContract redaction — internal fields must NOT survive
const raw = {
  customerName: 'Jane', total: 1200, status: 'draft',
  terms: ['t1', 't2'],
  lines: [{ description: 'Install', amount: 1000, _labor: 300, _material: 250, cost: 550, margin: 0.45 }],
  signature: null,
  _internalNotes: 'cost is 550, charge 1000', estimatorMargin: 0.45
};
const pc = publicContract(raw);
ok('keeps description+amount', pc.lines[0].description === 'Install' && pc.lines[0].amount === 1000);
ok('drops _labor', !('_labor' in pc.lines[0]));
ok('drops _material', !('_material' in pc.lines[0]));
ok('drops cost', !('cost' in pc.lines[0]));
ok('drops margin', !('margin' in pc.lines[0]));
ok('no internal notes on view', !('_internalNotes' in pc) && !('estimatorMargin' in pc));
ok('total preserved', pc.total === 1200);
ok('terms preserved', pc.terms.length === 2);
ok('not signed', pc.signed === false && pc.signedBy === null);

const signed = publicContract({ customerName: 'Jane', total: 100, status: 'signed', lines: [], signature: { name: 'Jane Doe', signedAt: '2026-06-01T00:00:00Z' } });
ok('signed exposes signer + date only', signed.signed === true && signed.signedBy === 'Jane Doe' && signed.signedAt === '2026-06-01T00:00:00Z');

// publicInvoice
ok('unpaid', publicInvoice({ amount: 1000, status: 'draft' }, 0).status === 'unpaid');
const partial = publicInvoice({ amount: 1000 }, 400);
ok('partial balance 600', partial.status === 'partial' && partial.balance === 600 && partial.paid === 400);
ok('paid when covered', publicInvoice({ amount: 1000 }, 1000).status === 'paid');
ok('overpay clamps paid to total', publicInvoice({ amount: 1000 }, 1500).paid === 1000 && publicInvoice({ amount: 1000 }, 1500).balance === 0);

// buildView
const v = buildView({ businessName: 'AAA', contract: raw, link: { allowSign: true }, invoice: { amount: 1200 }, paidAmount: 0 });
ok('view canSign true for draft+allowSign', v.canSign === true);
ok('view has redacted contract', v.contract.lines[0]._labor === undefined);
ok('view invoice present', v.invoice.total === 1200 && v.invoice.status === 'unpaid');
const v2 = buildView({ businessName: 'AAA', contract: { status: 'signed', lines: [] }, link: { allowSign: true } });
ok('canSign false once signed', v2.canSign === false);
const v3 = buildView({ businessName: 'AAA', contract: raw, link: { allowSign: false } });
ok('canSign false when link disallows', v3.canSign === false);

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
