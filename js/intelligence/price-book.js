/*
 * AAA Price Book — the canonical, margin-floored rate catalog.
 *
 * This is the GROUNDING layer for pricing: it turns a requested job into a
 * priced draft (line items, modifiers, trip minimum, margin floor) purely from
 * the owner-governed catalog. It is the "anchor" the Pricing Resolver consumes.
 *
 * ── Governance decisions baked in ──────────────────────────────────────────
 *  • Margin floor is PRICE-BASED (a dollar amount per unit), never a % of price.
 *  • Modifiers are explicit FLAT or PER-UNIT by default.
 *  • MULTIPLIERS are allowed ONLY for HEAVY_SOIL, AFTER_HOURS,
 *    EMERGENCY_SERVICE, COMMERCIAL (enforced by validateCatalog()).
 *  • Modifiers COUNT TOWARD the trip minimum (subtotal incl. modifiers is what
 *    is compared against it).
 *  • The ONLY owner-confirmed real rate is shampoo = $45/room (active).
 *  • Every other service rate is a DRAFT PLACEHOLDER requiring owner review;
 *    using one surfaces a contradiction and flags the draft for review.
 *
 * ── HARD FIREWALL ──────────────────────────────────────────────────────────
 *  The Price Book is grounding, NOT learning. It MUST NOT read outcomes, quotes,
 *  comparables, or any history. This module references no such global and does
 *  not touch the app data store at all — the catalog is canonical, in-code,
 *  and versioned.
 *  (Firewall is asserted statically AND at runtime in the test suite.)
 *
 * price() is PURE and deterministic. No I/O, no ledger, no network.
 */
;(function (global) {
  'use strict';

  const CATALOG_VERSION = 1;
  const CURRENCY = 'USD';
  // Multipliers are allowed ONLY for these four contexts. Everything else must
  // be expressed as an explicit flat or per-unit modifier.
  const MULTIPLIER_WHITELIST = ['HEAVY_SOIL', 'AFTER_HOURS', 'EMERGENCY_SERVICE', 'COMMERCIAL'];

  function cite(kind, code, v) { return 'cite:' + kind + ':' + code + ':v' + v; }

  // ── Canonical catalog (the single source of truth) ────────────────────────
  // confirmed:true  → an owner-confirmed real figure.
  // status:'draft'  → a placeholder rate; using it requires owner review.
  const SERVICES = {
    // The one real, owner-confirmed rate.
    shampoo:         { code: 'shampoo', label: 'Carpet Shampoo', unit: 'room', rate: 45, floor: 30, status: 'active', confirmed: true, version: 1, source: 'owner-confirmed 2026' },
    // Draft placeholders — plausible, but NOT owner-confirmed.
    steam_clean:     { code: 'steam_clean', label: 'Steam / Hot-Water Extraction', unit: 'room', rate: 65, floor: 40, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    deep_clean:      { code: 'deep_clean', label: 'Deep Restorative Clean', unit: 'room', rate: 85, floor: 55, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    pet_treatment:   { code: 'pet_treatment', label: 'Pet Odor / Enzyme Treatment', unit: 'room', rate: 35, floor: 20, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    stain_treatment: { code: 'stain_treatment', label: 'Spot / Stain Treatment', unit: 'flat', rate: 75, floor: 45, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    upholstery:      { code: 'upholstery', label: 'Upholstery Cleaning', unit: 'piece', rate: 90, floor: 55, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    tile_grout:      { code: 'tile_grout', label: 'Tile & Grout', unit: 'sqft', rate: 2.5, floor: 1.5, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    area_rug:        { code: 'area_rug', label: 'Area Rug (off-site)', unit: 'piece', rate: 120, floor: 70, status: 'draft', confirmed: false, version: 1, source: 'placeholder' }
  };

  const MODIFIERS = {
    // The four sanctioned multipliers (still DRAFT factors — only shampoo's rate is confirmed).
    HEAVY_SOIL:        { code: 'HEAVY_SOIL', label: 'Heavy Soil', kind: 'multiplier', factor: 1.30, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    AFTER_HOURS:       { code: 'AFTER_HOURS', label: 'After Hours', kind: 'multiplier', factor: 1.25, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    EMERGENCY_SERVICE: { code: 'EMERGENCY_SERVICE', label: 'Emergency Service', kind: 'multiplier', factor: 1.50, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    COMMERCIAL:        { code: 'COMMERCIAL', label: 'Commercial', kind: 'multiplier', factor: 1.20, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    // Everything else is explicit flat / per-unit.
    STAIRS:            { code: 'STAIRS', label: 'Stairs', kind: 'per_unit', unit: 'step', amount: 5, floor: 3, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    FURNITURE_MOVE:    { code: 'FURNITURE_MOVE', label: 'Furniture Moving', kind: 'flat', amount: 40, floor: 25, status: 'draft', confirmed: false, version: 1, source: 'placeholder' },
    PROTECTANT:        { code: 'PROTECTANT', label: 'Fabric Protectant', kind: 'per_unit', unit: 'room', amount: 12, floor: 7, status: 'draft', confirmed: false, version: 1, source: 'placeholder' }
  };

  // Trip minimum is owner POLICY (not a service rate), so it is confirmed.
  const TRIP_MINIMUM = { amount: 150, floor: 90, status: 'active', confirmed: true, version: 1, source: 'owner policy' };

  function buildCatalog() {
    return {
      version: CATALOG_VERSION, currency: CURRENCY,
      multiplierWhitelist: MULTIPLIER_WHITELIST.slice(),
      services: SERVICES, modifiers: MODIFIERS, tripMinimum: TRIP_MINIMUM
    };
  }
  // Deep-ish copy so callers can read but not mutate the canonical catalog.
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // ── pure helpers ───────────────────────────────────────────────────────────
  function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')); return isNaN(n) ? null : n; }
  function money(x) { return Math.round(x * 100) / 100; }
  function r3(x) { return Math.round(x * 1000) / 1000; }

  /**
   * Invariant check: no modifier may be a multiplier unless whitelisted; a
   * whitelisted modifier, if present, must be a multiplier. Returns violations.
   */
  function validateCatalog(cat) {
    cat = cat || buildCatalog();
    const violations = [];
    const mods = cat.modifiers || {};
    const wl = cat.multiplierWhitelist || MULTIPLIER_WHITELIST;
    Object.keys(mods).forEach(function (code) {
      const m = mods[code];
      if (m.kind === 'multiplier' && wl.indexOf(code) === -1) violations.push({ code: code, error: 'ILLEGAL_MULTIPLIER', message: code + ' is a multiplier but not whitelisted' });
      if (wl.indexOf(code) !== -1 && m.kind !== 'multiplier') violations.push({ code: code, error: 'WHITELISTED_NOT_MULTIPLIER', message: code + ' is whitelisted for multiplier use but declared ' + m.kind });
    });
    return { ok: violations.length === 0, violations: violations };
  }

  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  /**
   * Price a requested job from the catalog. PURE — reads nothing but the request
   * and the canonical catalog (no outcomes, no quotes, no comps, no data store).
   *
   * request: {
   *   items: [{ service:'shampoo', qty:4 }, ...],
   *   modifiers: [ 'HEAVY_SOIL', { code:'STAIRS', qty:12 }, ... ],
   *   context?: { ... }   // free-form, recorded as grounding only
   * }
   */
  function price(request) {
    request = request || {};
    const contradictions = [];
    const citations = [];
    const resolvedVersions = { catalog: CATALOG_VERSION, entries: {} };
    function note(code, message, extra) { contradictions.push(Object.assign({ code: code, message: message }, extra || {})); }
    function citeEntry(kind, e) {
      resolvedVersions.entries[e.code] = e.version;
      citations.push({ id: cite(kind, e.code, e.version), code: e.code, kind: kind, source: e.source, version: e.version, confirmed: e.confirmed === true });
    }

    const reqItems = Array.isArray(request.items) ? request.items : [];
    if (!reqItems.length) note('EMPTY_REQUEST', 'No service line items were requested');

    // ── line items ────────────────────────────────────────────────────────
    const lineItems = [];
    let serviceSubtotal = 0, floorSubtotal = 0;
    let anyUnconfirmedFloor = false;
    reqItems.forEach(function (it) {
      const code = it && it.service;
      const qty = Math.max(0, num(it && it.qty) != null ? num(it.qty) : 1);
      const svc = SERVICES[code];
      if (!svc) {
        note('UNKNOWN_SERVICE', 'No catalog rate for service "' + code + '"', { service: code });
        lineItems.push({ service: code || null, label: null, unit: null, qty: qty, rate: null, amount: 0, status: 'unknown', confirmed: false, requiresOwnerReview: true, grounding: 'no catalog entry', citationId: null });
        return;
      }
      const amount = money(svc.rate * qty);
      const fl = money(svc.floor * qty);
      serviceSubtotal += amount; floorSubtotal += fl;
      if (!svc.confirmed) { note('DRAFT_RATE_PLACEHOLDER', svc.label + ' uses a DRAFT placeholder rate — owner review required', { service: code }); }
      if (svc.confirmed === false) anyUnconfirmedFloor = true; // floor basis inherits the entry's confidence
      citeEntry('service', svc);
      lineItems.push({
        service: code, label: svc.label, unit: svc.unit, qty: qty, rate: svc.rate, amount: amount, floor: fl,
        status: svc.status, confirmed: svc.confirmed === true, requiresOwnerReview: svc.confirmed !== true,
        grounding: 'price book ' + svc.code + ' v' + svc.version + ' @ $' + svc.rate + '/' + svc.unit + (svc.confirmed ? ' (owner-confirmed)' : ' (draft placeholder)'),
        citationId: cite('service', svc.code, svc.version)
      });
    });

    // ── modifiers (multipliers compound on the service subtotal; flat/per-unit add after) ──
    const reqMods = Array.isArray(request.modifiers) ? request.modifiers : [];
    const modifierItems = [];
    let runningMult = serviceSubtotal;   // for attributing each multiplier's delta
    let multiplierFactor = 1;
    let additive = 0, additiveFloor = 0;
    reqMods.forEach(function (rm) {
      const code = typeof rm === 'string' ? rm : (rm && rm.code);
      const qty = Math.max(0, num(rm && rm.qty) != null ? num(rm.qty) : 1);
      const mod = MODIFIERS[code];
      if (!mod) { note('UNKNOWN_MODIFIER', 'No catalog modifier "' + code + '"', { modifier: code }); modifierItems.push({ code: code || null, kind: null, amount: 0, status: 'unknown', confirmed: false, countsTowardTripMinimum: false, requiresOwnerReview: true, grounding: 'no catalog entry', citationId: null }); return; }
      if (!mod.confirmed) note('DRAFT_MODIFIER_PLACEHOLDER', mod.label + ' uses a DRAFT placeholder rate — owner review required', { modifier: code });
      citeEntry('modifier', mod);

      let amount = 0, basis = '';
      if (mod.kind === 'multiplier') {
        // Defensive: a multiplier must be whitelisted (validateCatalog also guards this).
        if (MULTIPLIER_WHITELIST.indexOf(code) === -1) { note('ILLEGAL_MULTIPLIER', code + ' may not be applied as a multiplier', { modifier: code }); return; }
        const delta = money(runningMult * (mod.factor - 1));
        amount = delta; runningMult += delta; multiplierFactor = r3(multiplierFactor * mod.factor);
        basis = '×' + mod.factor + ' on service subtotal';
      } else if (mod.kind === 'per_unit') {
        amount = money(mod.amount * qty); additive += amount; additiveFloor += money((mod.floor != null ? mod.floor : 0) * qty);
        basis = '$' + mod.amount + '/' + (mod.unit || 'unit') + ' × ' + qty;
      } else { // flat
        amount = money(mod.amount); additive += amount; additiveFloor += money(mod.floor != null ? mod.floor : 0);
        basis = '$' + mod.amount + ' flat';
      }
      if (mod.confirmed === false) anyUnconfirmedFloor = true;
      modifierItems.push({
        code: code, label: mod.label, kind: mod.kind, factor: mod.kind === 'multiplier' ? mod.factor : null, qty: mod.kind === 'per_unit' ? qty : null,
        amount: amount, basis: basis, status: mod.status, confirmed: mod.confirmed === true,
        countsTowardTripMinimum: true, requiresOwnerReview: mod.confirmed !== true,
        grounding: 'price book ' + mod.code + ' v' + mod.version + ' (' + basis + ')' + (mod.confirmed ? ' (owner-confirmed)' : ' (draft placeholder)'),
        citationId: cite('modifier', mod.code, mod.version)
      });
    });

    const multiplierUplift = money(runningMult - serviceSubtotal);
    // Subtotal INCLUDING modifiers — this is what the trip minimum is checked against.
    const subtotal = money(serviceSubtotal + multiplierUplift + additive);

    // ── trip minimum (modifiers already counted in `subtotal`) ──────────────
    citeEntry('trip_minimum', Object.assign({ code: 'TRIP_MINIMUM' }, TRIP_MINIMUM));
    const tripMinimum = TRIP_MINIMUM.amount;
    const tripMinimumApplied = subtotal < tripMinimum;
    const tripMinimumAdjustment = tripMinimumApplied ? money(tripMinimum - subtotal) : 0;
    const priceVal = money(Math.max(subtotal, tripMinimum));

    // ── margin floor (price-based; scaled by the same multipliers) ──────────
    const marginFloor = money(floorSubtotal * multiplierFactor + additiveFloor);
    if (marginFloor > priceVal) note('FLOOR_ABOVE_PRICE', 'Margin floor ($' + marginFloor + ') exceeds the priced amount ($' + priceVal + ')', { marginFloor: marginFloor, price: priceVal });
    if (anyUnconfirmedFloor) note('FLOOR_NOT_CONFIRMED', 'Margin floor includes draft (non-owner-confirmed) figures');

    // ── status ──────────────────────────────────────────────────────────────
    const blocking = contradictions.filter(function (c) { return c.code !== 'FLOOR_ABOVE_PRICE'; });
    const requiresOwnerReview = blocking.length > 0;
    const status = requiresOwnerReview ? 'draft_review_required' : 'priced';

    const draft = {
      ok: true,
      draftId: (ids() && ids().createId) ? ids().createId('pbk') : null,
      status: status,
      requiresOwnerReview: requiresOwnerReview,

      lineItems: lineItems,
      modifierItems: modifierItems,
      tripMinimum: tripMinimum,
      tripMinimumApplied: tripMinimumApplied,
      tripMinimumAdjustment: tripMinimumAdjustment,
      price: priceVal,
      marginFloor: marginFloor,

      priceGrounding: {
        method: 'price = serviceSubtotal × Π(multiplier factors) + Σ(flat/per-unit modifiers), bumped to the trip minimum',
        catalogVersion: CATALOG_VERSION, currency: CURRENCY,
        serviceSubtotal: money(serviceSubtotal), multiplierFactor: multiplierFactor, multiplierUplift: multiplierUplift,
        additiveModifiers: money(additive), subtotal: subtotal, tripMinimum: tripMinimum, tripMinimumApplied: tripMinimumApplied
      },
      floorGrounding: {
        method: 'price-based per-unit floors from the catalog, scaled by service multipliers, plus additive-modifier floors. NEVER derived from outcomes, quotes, or comparables.',
        floorSubtotal: money(floorSubtotal), multiplierFactor: multiplierFactor, additiveFloor: money(additiveFloor),
        confirmed: !anyUnconfirmedFloor
      },

      citations: citations,
      contradictions: contradictions,
      resolvedVersions: resolvedVersions
    };
    if (clock() && clock().nowISO) draft.at = clock().nowISO();
    return draft;
  }

  const PriceBook = {
    VERSION: CATALOG_VERSION,
    MULTIPLIER_WHITELIST: MULTIPLIER_WHITELIST.slice(),

    /** Read-only copy of the canonical catalog. */
    catalog: function () { return clone(buildCatalog()); },
    getService: function (code) { return SERVICES[code] ? clone(SERVICES[code]) : null; },
    getModifier: function (code) { return MODIFIERS[code] ? clone(MODIFIERS[code]) : null; },

    validateCatalog: validateCatalog,
    price: price,

    /** Owner worklist: every entry that is a draft placeholder needing review. */
    draftEntries: function () {
      const out = [];
      Object.keys(SERVICES).forEach(function (k) { if (SERVICES[k].confirmed !== true) out.push(Object.assign({ kind: 'service' }, clone(SERVICES[k]))); });
      Object.keys(MODIFIERS).forEach(function (k) { if (MODIFIERS[k].confirmed !== true) out.push(Object.assign({ kind: 'modifier' }, clone(MODIFIERS[k]))); });
      return out;
    }
  };

  global.AAA_PRICE_BOOK = PriceBook;
})(typeof window !== 'undefined' ? window : this);
