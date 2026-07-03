/*
 * AAA Country Packs — the international layer as CONFIGURATION, not code.
 *
 * Every workflow that touches money, tax, measurements, invoices, or privacy
 * reads the active country pack instead of assuming "United States". Adding a
 * country is a register() call with a data pack — no core surgery, which is
 * the property that lets the platform serve new markets without a rewrite.
 *
 *   get(code) / list() / active()      pack lookup; active() reads AAA_CONFIG.countryCode (default US)
 *   register(pack)                     validate + install a new country at runtime
 *   formatMoney(amount, code?)         currency-correct display for that market
 *   tax(subtotal, {code, ratePct})     tax-exclusive math (sales tax / VAT / GST aware)
 *   extractTax(gross, {code, ratePct}) pull the contained tax out of a tax-inclusive price
 *   convertArea(value, from, to)       sqft ↔ sqm (flooring is measured differently abroad)
 *   validateInvoice(invoice, code?)    does this invoice satisfy that country's legal fields?
 *
 * Honest by construction: unknown country codes return null / {ok:false} —
 * never a silent fallback that quietly bills a German customer like a Texan.
 * All functions are pure and null-safe; nothing here calls a model or writes.
 */
;(function (global) {
  'use strict';

  const SQFT_PER_SQM = 10.7639104;

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }

  // ---- built-in packs (starter markets) -----------------------------------
  // Tax rates are the country-level DEFAULT for estimates; the owner can
  // override per-quote or via config (regional rates vary within countries).
  const BUILTIN = [
    {
      code: 'US', name: 'United States', language: 'en', locale: 'en-US',
      currency: { code: 'USD', symbol: '$', decimals: 2 },
      tax: { type: 'sales_tax', label: 'Sales Tax', defaultRatePct: 8.25, pricesIncludeTax: false, taxIdLabel: 'EIN' },
      units: { system: 'imperial', area: 'sqft', length: 'ft' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total'], taxIdRequired: false, sequentialNumbering: false, eInvoicing: false },
      phone: { prefix: '+1' },
      compliance: { privacyRegime: 'CCPA', gdpr: false }
    },
    {
      code: 'CA', name: 'Canada', language: 'en', locale: 'en-CA',
      currency: { code: 'CAD', symbol: '$', decimals: 2 },
      tax: { type: 'gst', label: 'GST/HST', defaultRatePct: 13, pricesIncludeTax: false, taxIdLabel: 'GST/HST Number' },
      units: { system: 'metric', area: 'sqm', length: 'm' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId'], taxIdRequired: true, sequentialNumbering: false, eInvoicing: false },
      phone: { prefix: '+1' },
      compliance: { privacyRegime: 'PIPEDA', gdpr: false }
    },
    {
      code: 'GB', name: 'United Kingdom', language: 'en', locale: 'en-GB',
      currency: { code: 'GBP', symbol: '£', decimals: 2 },
      tax: { type: 'vat', label: 'VAT', defaultRatePct: 20, pricesIncludeTax: true, taxIdLabel: 'VAT Number' },
      units: { system: 'metric', area: 'sqm', length: 'm' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId'], taxIdRequired: true, sequentialNumbering: true, eInvoicing: false },
      phone: { prefix: '+44' },
      compliance: { privacyRegime: 'UK GDPR', gdpr: true }
    },
    {
      code: 'DE', name: 'Germany', language: 'de', locale: 'de-DE',
      currency: { code: 'EUR', symbol: '€', decimals: 2 },
      tax: { type: 'vat', label: 'USt.', defaultRatePct: 19, pricesIncludeTax: true, taxIdLabel: 'USt-IdNr.' },
      units: { system: 'metric', area: 'sqm', length: 'm' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId', 'customerAddress'], taxIdRequired: true, sequentialNumbering: true, eInvoicing: false },
      phone: { prefix: '+49' },
      compliance: { privacyRegime: 'GDPR', gdpr: true }
    },
    {
      code: 'AU', name: 'Australia', language: 'en', locale: 'en-AU',
      currency: { code: 'AUD', symbol: '$', decimals: 2 },
      tax: { type: 'gst', label: 'GST', defaultRatePct: 10, pricesIncludeTax: true, taxIdLabel: 'ABN' },
      units: { system: 'metric', area: 'sqm', length: 'm' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId'], taxIdRequired: true, sequentialNumbering: false, eInvoicing: false },
      phone: { prefix: '+61' },
      compliance: { privacyRegime: 'Privacy Act 1988', gdpr: false }
    },
    {
      code: 'MX', name: 'Mexico', language: 'es', locale: 'es-MX',
      currency: { code: 'MXN', symbol: '$', decimals: 2 },
      tax: { type: 'vat', label: 'IVA', defaultRatePct: 16, pricesIncludeTax: true, taxIdLabel: 'RFC' },
      units: { system: 'metric', area: 'sqm', length: 'm' },
      invoice: { requiredFields: ['businessName', 'invoiceNumber', 'date', 'lineItems', 'total', 'taxId'], taxIdRequired: true, sequentialNumbering: true, eInvoicing: true },
      phone: { prefix: '+52' },
      compliance: { privacyRegime: 'LFPDPPP', gdpr: false }
    }
  ];

  const PACKS = {};
  BUILTIN.forEach(function (p) { PACKS[p.code] = p; });

  // ---- validation ----------------------------------------------------------
  function validatePack(pack) {
    const issues = [];
    if (!pack || typeof pack !== 'object') return { ok: false, issues: ['NOT_AN_OBJECT'] };
    if (!pack.code || !/^[A-Z]{2}$/.test(String(pack.code))) issues.push('code must be a 2-letter ISO country code');
    if (!pack.name) issues.push('name required');
    if (!pack.currency || !pack.currency.code || !/^[A-Z]{3}$/.test(String(pack.currency.code))) issues.push('currency.code must be a 3-letter ISO code');
    if (!pack.tax || ['sales_tax', 'vat', 'gst', 'none'].indexOf(pack.tax && pack.tax.type) === -1) issues.push('tax.type must be sales_tax|vat|gst|none');
    if (pack.tax && pack.tax.type !== 'none' && !(isFinite(+pack.tax.defaultRatePct) && +pack.tax.defaultRatePct >= 0)) issues.push('tax.defaultRatePct must be a non-negative number');
    if (!pack.units || ['sqft', 'sqm'].indexOf(pack.units && pack.units.area) === -1) issues.push('units.area must be sqft|sqm');
    if (!pack.invoice || !Array.isArray(pack.invoice.requiredFields) || !pack.invoice.requiredFields.length) issues.push('invoice.requiredFields must be a non-empty array');
    return issues.length ? { ok: false, issues: issues } : { ok: true };
  }

  function round2(n, decimals) {
    const f = Math.pow(10, decimals == null ? 2 : decimals);
    return Math.round(n * f) / f;
  }

  function resolve(code) {
    if (code == null) return PACKS[String(flag('countryCode', 'US')).toUpperCase()] || null;
    return PACKS[String(code).toUpperCase()] || null;
  }

  const CountryPacks = {
    /** The pack for an explicit code, or null (never a silent fallback). */
    get: function (code) { return PACKS[String(code || '').toUpperCase()] || null; },

    /** All installed markets, as summaries. */
    list: function () {
      return Object.keys(PACKS).sort().map(function (c) {
        const p = PACKS[c];
        return { code: p.code, name: p.name, currency: p.currency.code, taxType: p.tax.type, language: p.language };
      });
    },

    /** The active market: AAA_CONFIG.countryCode, defaulting to US. */
    active: function () { return resolve(null) || PACKS.US; },
    activeCode: function () { return this.active().code; },

    /** Install a new country at runtime. Validated; refuses bad packs. */
    register: function (pack) {
      const v = validatePack(pack);
      if (!v.ok) return v;
      PACKS[pack.code] = pack;
      return { ok: true, code: pack.code };
    },
    validatePack: validatePack,

    /** Currency-correct display for a market. Unknown code → honest error. */
    formatMoney: function (amount, code) {
      const p = code == null ? this.active() : this.get(code);
      if (!p) return { ok: false, error: 'UNKNOWN_COUNTRY', code: code };
      const n = +amount;
      if (!isFinite(n)) return { ok: false, error: 'NOT_A_NUMBER', value: amount };
      let text;
      try {
        text = new Intl.NumberFormat(p.locale, { style: 'currency', currency: p.currency.code }).format(n);
      } catch (_) {
        text = p.currency.symbol + round2(n, p.currency.decimals).toFixed(p.currency.decimals);
      }
      return { ok: true, text: text, amount: round2(n, p.currency.decimals), currency: p.currency.code };
    },

    /**
     * Tax math on a tax-EXCLUSIVE subtotal. Returns the market's label/type so
     * a quote in Berlin says "USt. 19%" and one in Houston says "Sales Tax".
     */
    tax: function (subtotal, opts) {
      const o = opts || {};
      const p = o.code == null ? this.active() : this.get(o.code);
      if (!p) return { ok: false, error: 'UNKNOWN_COUNTRY', code: o.code };
      const sub = +subtotal;
      if (!isFinite(sub) || sub < 0) return { ok: false, error: 'BAD_SUBTOTAL', value: subtotal };
      const rate = isFinite(+o.ratePct) ? +o.ratePct : (p.tax.type === 'none' ? 0 : p.tax.defaultRatePct);
      const d = p.currency.decimals;
      const tax = round2(sub * rate / 100, d);
      return {
        ok: true, subtotal: round2(sub, d), ratePct: rate, tax: tax,
        total: round2(sub + tax, d), label: p.tax.label, type: p.tax.type,
        currency: p.currency.code, pricesIncludeTax: !!p.tax.pricesIncludeTax
      };
    },

    /** Pull the contained tax out of a tax-INCLUSIVE (gross) price. */
    extractTax: function (gross, opts) {
      const o = opts || {};
      const p = o.code == null ? this.active() : this.get(o.code);
      if (!p) return { ok: false, error: 'UNKNOWN_COUNTRY', code: o.code };
      const g = +gross;
      if (!isFinite(g) || g < 0) return { ok: false, error: 'BAD_GROSS', value: gross };
      const rate = isFinite(+o.ratePct) ? +o.ratePct : (p.tax.type === 'none' ? 0 : p.tax.defaultRatePct);
      const d = p.currency.decimals;
      const net = round2(g / (1 + rate / 100), d);
      return { ok: true, gross: round2(g, d), net: net, tax: round2(g - net, d), ratePct: rate, label: p.tax.label, currency: p.currency.code };
    },

    /** sqft ↔ sqm (identity when units match). The field crew measures in one; the invoice may need the other. */
    convertArea: function (value, from, to) {
      const v = +value;
      if (!isFinite(v)) return { ok: false, error: 'NOT_A_NUMBER', value: value };
      const f = String(from || '').toLowerCase(), t = String(to || '').toLowerCase();
      if (['sqft', 'sqm'].indexOf(f) === -1 || ['sqft', 'sqm'].indexOf(t) === -1) return { ok: false, error: 'BAD_UNIT', from: from, to: to };
      if (f === t) return { ok: true, value: v, unit: t };
      const out = f === 'sqft' ? v / SQFT_PER_SQM : v * SQFT_PER_SQM;
      return { ok: true, value: Math.round(out * 10000) / 10000, unit: t };
    },

    /**
     * Does this invoice object satisfy the market's legally required fields?
     * Pure check — names the gaps instead of throwing.
     */
    validateInvoice: function (invoice, code) {
      const p = code == null ? this.active() : this.get(code);
      if (!p) return { ok: false, error: 'UNKNOWN_COUNTRY', code: code };
      const inv = invoice || {};
      const missing = p.invoice.requiredFields.filter(function (f) {
        const v = inv[f];
        return v == null || v === '' || (Array.isArray(v) && !v.length);
      });
      const issues = [];
      if (p.invoice.taxIdRequired && (inv.taxId == null || inv.taxId === '')) {
        if (missing.indexOf('taxId') === -1) missing.push('taxId');
        issues.push(p.tax.taxIdLabel + ' is legally required on ' + p.name + ' invoices');
      }
      if (p.invoice.sequentialNumbering && inv.invoiceNumber != null && !/\d/.test(String(inv.invoiceNumber))) {
        issues.push(p.name + ' requires sequential invoice numbering (invoiceNumber must contain a sequence)');
      }
      return missing.length || issues.length
        ? { ok: false, missing: missing, issues: issues, country: p.code }
        : { ok: true, country: p.code };
    },

    /** Compact locale context for agent prompts: how THIS market works. */
    contextFor: function (code) {
      const p = code == null ? this.active() : this.get(code);
      if (!p) return null;
      return {
        country: p.code, countryName: p.name, language: p.language, locale: p.locale,
        currency: p.currency.code, taxType: p.tax.type, taxLabel: p.tax.label,
        taxRatePct: p.tax.defaultRatePct, pricesIncludeTax: !!p.tax.pricesIncludeTax,
        areaUnit: p.units.area, privacyRegime: p.compliance.privacyRegime, gdpr: !!p.compliance.gdpr
      };
    }
  };

  global.AAA_COUNTRY_PACKS = CountryPacks;
})(typeof window !== 'undefined' ? window : this);
