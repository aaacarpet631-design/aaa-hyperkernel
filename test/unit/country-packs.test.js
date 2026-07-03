/* Country Packs — the international layer as configuration.
 *
 * Guards the honest contract: unknown countries return errors (never a silent
 * US fallback), tax math matches each market's regime (exclusive sales tax vs
 * inclusive VAT/GST), area conversion round-trips, invoice validation names
 * the legally missing fields, and register() refuses malformed packs. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('country-packs');
  const { G, cfg } = setupEnv();
  load('js/core/country-packs.js');
  const CP = G.AAA_COUNTRY_PACKS;

  // ===== built-in markets =====
  const codes = CP.list().map((p) => p.code);
  t.ok('six starter markets installed', ['AU', 'CA', 'DE', 'GB', 'MX', 'US'].every((c) => codes.indexOf(c) !== -1));
  t.eq('active market defaults to US', CP.activeCode(), 'US');
  cfg.set({ countryCode: 'de' });
  t.eq('config countryCode switches the active market (case-insensitive)', CP.activeCode(), 'DE');
  cfg.set({ countryCode: 'US' });

  // ===== honest unknowns — never a silent fallback =====
  t.eq('unknown country → null pack', CP.get('ZZ'), null);
  t.eq('unknown country → formatMoney refuses', CP.formatMoney(100, 'ZZ').error, 'UNKNOWN_COUNTRY');
  t.eq('unknown country → tax refuses', CP.tax(100, { code: 'ZZ' }).error, 'UNKNOWN_COUNTRY');
  t.eq('unknown country → validateInvoice refuses', CP.validateInvoice({}, 'ZZ').error, 'UNKNOWN_COUNTRY');

  // ===== money formatting per market =====
  const us = CP.formatMoney(1234.5, 'US');
  t.ok('US money formats as USD', us.ok && us.currency === 'USD' && /1,?234/.test(us.text));
  const de = CP.formatMoney(1234.5, 'DE');
  t.ok('DE money formats as EUR', de.ok && de.currency === 'EUR' && de.text.indexOf('€') !== -1);
  t.eq('non-numeric money refused', CP.formatMoney('abc', 'US').error, 'NOT_A_NUMBER');

  // ===== tax regimes =====
  const usTax = CP.tax(1000, { code: 'US' });
  t.ok('US sales tax: exclusive, labeled', usTax.type === 'sales_tax' && usTax.label === 'Sales Tax' && usTax.pricesIncludeTax === false);
  t.eq('US default 8.25% on $1000', usTax.tax, 82.5);
  t.eq('US total', usTax.total, 1082.5);
  const deTax = CP.tax(1000, { code: 'DE' });
  t.ok('DE VAT: 19%, inclusive-display market', deTax.ratePct === 19 && deTax.tax === 190 && deTax.pricesIncludeTax === true && deTax.label === 'USt.');
  const auTax = CP.tax(1000, { code: 'AU', ratePct: 10 });
  t.eq('explicit rate override respected', auTax.tax, 100);
  t.eq('negative subtotal refused', CP.tax(-5, { code: 'US' }).error, 'BAD_SUBTOTAL');

  // ===== inclusive-price tax extraction =====
  const ex = CP.extractTax(1190, { code: 'DE' });
  t.ok('DE: €1190 gross contains €190 USt on €1000 net', ex.net === 1000 && ex.tax === 190);
  const exGb = CP.extractTax(120, { code: 'GB' });
  t.ok('GB: £120 gross contains £20 VAT', exGb.net === 100 && exGb.tax === 20);

  // ===== area conversion (field crew ↔ market units) =====
  const sqm = CP.convertArea(1076.39104, 'sqft', 'sqm');
  t.ok('1076.39 sqft ≈ 100 sqm', sqm.ok && Math.abs(sqm.value - 100) < 0.001);
  const back = CP.convertArea(sqm.value, 'sqm', 'sqft');
  t.ok('round-trips within a hundredth of a sqft', Math.abs(back.value - 1076.39104) < 0.01);
  t.eq('same-unit passthrough', CP.convertArea(42, 'sqm', 'sqm').value, 42);
  t.eq('bad unit refused', CP.convertArea(1, 'acres', 'sqm').error, 'BAD_UNIT');

  // ===== invoice validation names the legal gaps =====
  const inv = { businessName: 'AAA Carpet', invoiceNumber: 'INV-001', date: '2026-07-03', lineItems: [{}], total: 500 };
  t.ok('US invoice without tax id is fine', CP.validateInvoice(inv, 'US').ok === true);
  const deInv = CP.validateInvoice(inv, 'DE');
  t.ok('DE invoice missing taxId + customerAddress fails with names', deInv.ok === false && deInv.missing.indexOf('taxId') !== -1 && deInv.missing.indexOf('customerAddress') !== -1);
  t.ok('DE issue message names the USt-IdNr.', deInv.issues.some((s) => s.indexOf('USt-IdNr.') !== -1));
  const deOk = CP.validateInvoice(Object.assign({}, inv, { taxId: 'DE123456789', customerAddress: 'Berlin' }), 'DE');
  t.ok('complete DE invoice passes', deOk.ok === true);

  // ===== runtime registration: a new market without core surgery =====
  const fr = {
    code: 'FR', name: 'France', language: 'fr', locale: 'fr-FR',
    currency: { code: 'EUR', symbol: '€', decimals: 2 },
    tax: { type: 'vat', label: 'TVA', defaultRatePct: 20, pricesIncludeTax: true, taxIdLabel: 'N° TVA' },
    units: { system: 'metric', area: 'sqm', length: 'm' },
    invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId'], taxIdRequired: true, sequentialNumbering: true, eInvoicing: true },
    phone: { prefix: '+33' },
    compliance: { privacyRegime: 'GDPR', gdpr: true }
  };
  t.ok('register(FR) installs a seventh market', CP.register(fr).ok === true && CP.get('FR').tax.label === 'TVA');
  t.eq('FR TVA math works immediately', CP.tax(100, { code: 'FR' }).tax, 20);
  const bad = CP.register({ code: 'X', currency: {} });
  t.ok('malformed pack refused with named issues', bad.ok === false && bad.issues.length >= 3);
  t.eq('malformed pack is NOT installed', CP.get('X'), null);

  // ===== agent prompt context =====
  const ctx = CP.contextFor('GB');
  t.ok('contextFor gives compact market facts', ctx.currency === 'GBP' && ctx.taxLabel === 'VAT' && ctx.gdpr === true && ctx.areaUnit === 'sqm');
  t.eq('contextFor unknown → null', CP.contextFor('ZZ'), null);

  return t.report();
};
