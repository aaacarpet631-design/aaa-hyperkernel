/* Contracts — totals from estimate ranges, sign + immutability, toText. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('contracts');
  const { G } = setupEnv();
  load('js/contracts/contract-store.js');
  const K = G.AAA_CONTRACTS;

  const c = await K.createFromJob({ id: 'j1', customerName: 'Jane Doe', customerId: 'c1', estimates: [{ type: 'Carpet Install', estimatedQuoteRange: '$900–$1100' }, { type: 'Stairs', estimatedQuoteRange: '$200' }] });
  t.eq('total from ranges (1000+200)', c.total, 1200);
  t.eq('starts draft', c.status, 'draft');
  t.ok('default terms attached', c.terms.length >= 3);

  t.ok('cannot sign without name', (await K.sign(c.id, { name: '' })).error === 'NAME_REQUIRED');
  const signed = await K.sign(c.id, { name: 'Jane Doe', dataUrl: 'data:image/png;base64,x' });
  t.ok('signed ok', signed.ok && signed.contract.status === 'signed' && signed.contract.signature.name === 'Jane Doe');
  t.ok('signedAt captured', !!signed.contract.signature.signedAt);
  t.ok('cannot re-sign (immutable)', (await K.sign(c.id, { name: 'Jane Doe' })).error === 'ALREADY_SIGNED');

  const txt = K.toText(signed.contract);
  t.ok('toText has total + signer', /Total: \$1200\.00/.test(txt) && /Signed by: Jane Doe/.test(txt));

  return t.report();
};
