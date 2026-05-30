/*
 * AAA Measurement → Quote integration.
 *
 * Turns measurement sessions into priced line items and feeds them into the
 * EXISTING job.estimates[] shape (estimateId, type, estimatedTimeMins,
 * materials, estimatedQuoteRange, source) so nothing downstream breaks. It also
 * produces a customer-facing RECEIPT view that hides labor/cost math — the
 * customer sees services + totals, never the contractor breakdown.
 *
 * Rates live in a configurable rate card (AAA_CONFIG override 'rateCard'), so
 * pricing is owner-controlled, not hardcoded. Defaults are clearly placeholder
 * starting points the owner should set in Cloud Settings. NOTHING here finalizes
 * a price without human review — it produces a draft the tech confirms.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }

  // Default rate card — STARTING POINTS only. Owner overrides via
  // AAA_CONFIG.set({ rateCard: {...} }) (exposed in the BLE setup screen).
  const DEFAULT_RATES = {
    install_per_sqft: 0.75,        // labor to install carpet, $/ft²
    material_per_sqft: 2.50,       // carpet material, $/ft²
    pad_per_sqft: 0.45,            // padding, $/ft²
    stretch_per_sqft: 0.55,        // re-stretch, $/ft²
    repair_per_linear_ft: 12.00,   // seam/patch repair, $/linear ft
    shampoo_per_sqft: 0.35,        // steam clean, $/ft²
    stairs_each: 6.00,             // per stair (install/clean)
    hallway_per_sqft: 0.85,        // hallway runner work, $/ft²
    apartment_turn_flat: 120.00,   // flat per-unit turn baseline
    commercial_per_sqft: 0.60,     // commercial install, $/ft²
    waste_factor: 0.10,            // +10% material for cuts/waste
    min_job: 95.00,                // minimum charge
    range_spread: 0.12             // +/-12% shown as the quote range
  };

  // Service catalog: which rate keys + which measurement fields each uses.
  const SERVICES = {
    carpet_install:   { label: 'Carpet Installation',  kind: 'area',   labor: 'install_per_sqft',    material: ['material_per_sqft', 'pad_per_sqft'], waste: true },
    carpet_stretch:   { label: 'Carpet Stretching',    kind: 'area',   labor: 'stretch_per_sqft' },
    carpet_repair:    { label: 'Carpet Repair',        kind: 'linear', labor: 'repair_per_linear_ft' },
    carpet_shampoo:   { label: 'Carpet Cleaning',      kind: 'area',   labor: 'shampoo_per_sqft' },
    stairs:           { label: 'Stairs',               kind: 'stairs', labor: 'stairs_each' },
    hallway:          { label: 'Hallway',              kind: 'area',   labor: 'hallway_per_sqft' },
    apartment_turn:   { label: 'Apartment Turn',       kind: 'flat',   labor: 'apartment_turn_flat' },
    commercial_room:  { label: 'Commercial Room',      kind: 'area',   labor: 'commercial_per_sqft', material: ['material_per_sqft'], waste: true }
  };

  function rates() { return Object.assign({}, DEFAULT_RATES, cfg().flag ? (cfg().flag('rateCard', {}) || {}) : {}); }

  const Integration = {
    SERVICES: SERVICES,
    defaultRates: function () { return Object.assign({}, DEFAULT_RATES); },
    currentRates: rates,

    serviceOptions() {
      return Object.keys(SERVICES).map((k) => ({ id: k, label: SERVICES[k].label, kind: SERVICES[k].kind }));
    },

    /**
     * Price one service for one or more measurement sessions.
     * Returns an internal line with BOTH cost detail and the customer view.
     * @param {string} serviceId  key of SERVICES
     * @param {MeasurementSession[]} sessions
     */
    priceService(serviceId, sessions) {
      const svc = SERVICES[serviceId];
      if (!svc) return null;
      const r = rates();
      const list = Array.isArray(sessions) ? sessions : [sessions];

      let area = 0, linear = 0, stairs = 0, units = list.length;
      list.forEach((s) => {
        if (!s) return;
        if (s.squareFeet != null) area += s.squareFeet;
        if (s.linearFeet != null) linear += s.linearFeet;
        stairs += s.stairsCount || 0;
      });

      let labor = 0, material = 0, basis = '';
      if (svc.kind === 'area') {
        labor = area * (r[svc.labor] || 0);
        basis = round(area, 1) + ' ft²';
        if (svc.material) {
          let mPerSq = svc.material.reduce((sum, key) => sum + (r[key] || 0), 0);
          material = area * mPerSq;
          if (svc.waste) material *= (1 + (r.waste_factor || 0));
        }
      } else if (svc.kind === 'linear') {
        labor = linear * (r[svc.labor] || 0);
        basis = round(linear, 1) + ' linear ft';
      } else if (svc.kind === 'stairs') {
        labor = stairs * (r[svc.labor] || 0);
        basis = stairs + ' stairs';
      } else if (svc.kind === 'flat') {
        labor = units * (r[svc.labor] || 0);
        basis = units + ' unit' + (units === 1 ? '' : 's');
      }

      let subtotal = labor + material;
      const belowMin = subtotal < (r.min_job || 0);
      if (belowMin) subtotal = r.min_job || 0;

      const spread = r.range_spread || 0;
      const low = round(subtotal * (1 - spread), 0);
      const high = round(subtotal * (1 + spread), 0);

      // Rough labor time estimate (mins) for the internal estimate record only.
      const estTimeMins = estimateMinutes(svc.kind, { area: area, linear: linear, stairs: stairs, units: units });

      return {
        serviceId: serviceId,
        label: svc.label,
        basis: basis,
        // INTERNAL (never shown to the customer):
        _labor: round(labor, 2),
        _material: round(material, 2),
        _belowMin: belowMin,
        // Customer-safe:
        subtotal: round(subtotal, 2),
        range: '$' + low + '–$' + high,
        estimatedTimeMins: estTimeMins,
        area: round(area, 1), linear: round(linear, 1), stairs: stairs
      };
    },

    /**
     * Build a full quote draft from selected services over the given sessions.
     * @param {Array<{serviceId:string, sessions:MeasurementSession[]}>} selections
     */
    buildQuote(selections) {
      const lines = [];
      (selections || []).forEach((sel) => {
        const line = this.priceService(sel.serviceId, sel.sessions);
        if (line) lines.push(line);
      });
      const total = round(lines.reduce((s, l) => s + l.subtotal, 0), 2);
      const laborTotal = round(lines.reduce((s, l) => s + l._labor, 0), 2);
      const materialTotal = round(lines.reduce((s, l) => s + l._material, 0), 2);
      const spread = rates().range_spread || 0;
      return {
        lines: lines,
        total: total,
        totalRange: '$' + round(total * (1 - spread), 0) + '–$' + round(total * (1 + spread), 0),
        _laborTotal: laborTotal,         // internal
        _materialTotal: materialTotal,   // internal
        needsReview: true                // ALWAYS — never auto-finalize
      };
    },

    /**
     * The customer-facing RECEIPT: services + amounts only. No labor, no
     * material breakdown, no rates — looks like a receipt, not a cost sheet.
     */
    toReceipt(quote, opts) {
      const o = opts || {};
      return {
        businessName: cfg().businessName || 'AAA Carpet',
        customerName: o.customerName || null,
        date: o.date || (global.AAA_RUNTIME_CLOCK ? global.AAA_RUNTIME_CLOCK.nowISO() : new Date().toISOString()),
        items: (quote.lines || []).map((l) => ({ description: l.label + (l.basis ? ' (' + l.basis + ')' : ''), amount: l.subtotal })),
        total: quote.total,
        estimateRange: quote.totalRange,
        note: o.note || 'Estimate — final price confirmed on site. Thank you for choosing ' + (cfg().businessName || 'AAA Carpet') + '!'
      };
    },

    /**
     * Convert quote lines into EXISTING job.estimates[] entries and append them
     * to the job via the same storage path the Vision HUD uses. Returns the
     * estimate entries (the caller persists/marks for review).
     */
    toEstimateEntries(quote, meta) {
      const m = meta || {};
      return (quote.lines || []).map((l) => ({
        estimateId: ids() ? ids().createId('est') : ('est_' + Date.now() + '_' + l.serviceId),
        type: l.label,
        estimatedTimeMins: l.estimatedTimeMins,
        materials: [],
        estimatedQuoteRange: l.range,
        source: 'MEASUREMENT',
        measurement: { basis: l.basis, area: l.area, linear: l.linear, stairs: l.stairs, sessionIds: m.sessionIds || [] },
        needsReview: true
      }));
    }
  };

  function estimateMinutes(kind, q) {
    if (kind === 'area') return Math.max(30, Math.round(q.area * 1.2));        // ~1.2 min/ft²
    if (kind === 'linear') return Math.max(30, Math.round(q.linear * 5));      // ~5 min/linear ft
    if (kind === 'stairs') return Math.max(15, Math.round(q.stairs * 8));      // ~8 min/stair
    if (kind === 'flat') return Math.max(60, q.units * 90);                    // ~90 min/unit
    return 60;
  }
  function round(n, p) { const f = Math.pow(10, p || 0); return Math.round(n * f) / f; }

  global.AAA_MEASUREMENT_QUOTE = Integration;
})(typeof window !== 'undefined' ? window : this);
