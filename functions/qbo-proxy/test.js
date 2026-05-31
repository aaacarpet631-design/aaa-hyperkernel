/* Offline unit tests for the QBO proxy's pure logic (no admin/network). */
'use strict';
const { sanitizeInvoice, isExpired, apiBase, isRetryable } = require('./lib');

let pass = 0, fail = 0;
const ok = (n, c) => c ? pass++ : (fail++, console.log('FAIL:', n));

// sanitizeInvoice keeps only the allowed QBO shape
const dirty = {
  _source: 'aaa', _sourceId: 'inv_1', evil: 'DROP TABLE',
  CustomerRef: { name: 'Jane' }, TxnDate: '2026-06-01',
  Line: [{ Amount: 1000, Description: 'Install', SalesItemLineDetail: { ItemRef: { name: 'Install' } } }, { Amount: 200, Description: 'Pad' }]
};
const clean = sanitizeInvoice(dirty);
ok('drops unknown top-level fields', !('evil' in clean) && !('_source' in clean));
ok('keeps CustomerRef + TxnDate', clean.CustomerRef.name === 'Jane' && clean.TxnDate === '2026-06-01');
ok('two lines, correct shape', clean.Line.length === 2 && clean.Line[0].DetailType === 'SalesItemLineDetail' && clean.Line[0].Amount === 1000);
ok('line without ItemRef gets default', clean.Line[1].SalesItemLineDetail.ItemRef.name === 'Services');
ok('coerces amount to number', typeof sanitizeInvoice({ Line: [{ Amount: '50' }] }).Line[0].Amount === 'number');

// isExpired
ok('null expiresAt => expired', isExpired(null, 0) === true);
ok('past => expired', isExpired(new Date(Date.now() - 1000).toISOString(), 0) === true);
ok('future => not expired', isExpired(new Date(Date.now() + 3600000).toISOString(), 0) === false);
ok('skew makes near-future expired', isExpired(new Date(Date.now() + 30000).toISOString(), 60000) === true);

// apiBase
ok('sandbox base', apiBase('sandbox').includes('sandbox-quickbooks'));
ok('production base', apiBase('production') === 'https://quickbooks.api.intuit.com');

// isRetryable
ok('429 retryable', isRetryable(429) === true);
ok('503 retryable', isRetryable(503) === true);
ok('network(0) retryable', isRetryable(0) === true);
ok('400 not retryable', isRetryable(400) === false);
ok('200 not retryable', isRetryable(200) === false);

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
