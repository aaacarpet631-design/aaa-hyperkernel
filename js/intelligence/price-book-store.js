/*
 * AAA Price Book — canonical pricing POLICY (not history, not evidence).
 *
 * Answers exactly one question: "what does our policy say this work should
 * cost, and what is the floor?" It is pure, deterministic, local-first, and
 * network-free. It computes a priced DRAFT from a structured job spec and the
 * active rate/modifier/trip-minimum policy — it never commits a price, never
 * calls a model, and never mutates a quote.
 *
 * FIREWALL (constitutional): Price Book is policy; the Outcome Spine is
 * history; comps are evidence. This module MUST NOT read AAA_OUTCOME_SPINE,
 * AAA_QUOTES, AAA_QUOTE_COMPS, or any historical outcome data. A unit test
 * asserts the firewall. The moment policy reads history, it starts ratifying
 * past underpricing as policy.
 *
 * Every priced draft carries: price grounding, floor grounding, citations,
 * contradictions, and the resolved rule versions — so an estimate is fully
 * explainable and intellectually honest about what it does not yet know.
 * In Phase A the honest ceiling for price grounding is PARTIAL: GROUNDED
 * requires comps (Phase B); a GROUNDED floor requires measured cost (Phase A.5).
 */
;(function (global) {
  'use strict';

  // ---- pure helpers ---------------------------------------------------------
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function round(n, p) { const f = Math.pow(10, p == null ? 2 : p); return Math.round(n * f) / f; }
  function nowMs() { const c = global.AAA_RUNTIME_CLOCK; return c && c.now ? c.now() : Date.now(); }
  function newId(prefix) { const f = global.AAA_ID_FACTORY; return f && f.createId ? f.createId(prefix) : (prefix + '_' + Math.random().toString(36).slice(2, 10)); }
  function toMs(v) { if (v == null) return null; if (typeof v === 'number') return v; const t = Date.parse(v); return isNaN(t) ? null : t; }
  // Normalize a margin to a 0..1 fraction (accepts 0.30 or 30).
  function marginFraction(v) { const n = num(v); if (n == null) return null; return n > 1 ? n / 100 : n; }

  const UNITS = ['PER_ROOM', 'PER_REPAIR', 'SQ_YARD', 'STAIR', 'CLOSET', 'TRIP_MINIMUM', 'ADD_ON'];
  const SERVICE_CATEGORIES = ['cleaning', 'repair', 'stretching', 'installation'];
  // Multipliers are allowed ONLY for these modifier keys; everything else must
  // be an explicit flat or per_unit line item (no hidden percentages).
  const MULTIPLIER_ALLOWLIST = ['HEAVY_SOIL', 'AFTER_HOURS', 'EMERGENCY_SERVICE', 'COMMERCIAL'];
  const PLACEHOLDER_SOURCE = 'placeholder_requires_owner_review';

  // ---- in-memory policy store (best-effort localStorage persistence) --------
  const STORAGE_KEY = 'aaa:price_book';
  let RATES = {};      // id -> rate
  let MODIFIERS = {};  // id -> modifier
  let TRIP_MINS = {};  // id -> trip minimum

  function lsGet() { try { const ls = global.localStorage; return ls ? ls.getItem(STORAGE_KEY) : null; } catch (_) { return null; } }
  function lsSet(json) { try { const ls = global.localStorage; if (ls) ls.setItem(STORAGE_KEY, json); } catch (_) {} }
  function persist() {
    try { lsSet(JSON.stringify({ rates: vals(RATES), modifiers: vals(MODIFIERS), tripMins: vals(TRIP_MINS) })); } catch (_) {}
  }
  function vals(map) { return Object.keys(map).map(function (k) { return map[k]; }); }
  function hydrate() {
    const raw = lsGet(); if (!raw) return;
    try {
      const d = JSON.parse(raw);
      (d.rates || []).forEach(function (r) { if (r && r.id) RATES[r.id] = r; });
      (d.modifiers || []).forEach(function (m) { if (m && m.id) MODIFIERS[m.id] = m; });
      (d.tripMins || []).forEach(function (x) { if (x && x.id) TRIP_MINS[x.id] = x; });
    } catch (_) {}
  }

  // ---- validation -----------------------------------------------------------
  function validateRate(r) {
    const e = [];
    if (!r || typeof r !== 'object') return { ok: false, errors: ['rate must be an object'] };
    if (SERVICE_CATEGORIES.indexOf(r.serviceCategory) === -1) e.push('serviceCategory must be one of ' + SERVICE_CATEGORIES.join('/'));
    if (!r.itemKey) e.push('missing itemKey');
    if (UNITS.indexOf(r.unit) === -1) e.push('unit must be one of ' + UNITS.join('/'));
    if (num(r.baseRate) == null) e.push('baseRate must be numeric');
    if (marginFraction(r.marginFloorPct) == null) e.push('marginFloorPct must be numeric');
    return { ok: e.length === 0, errors: e };
  }
  function validateModifier(m) {
    const e = [];
    if (!m || typeof m !== 'object') return { ok: false, errors: ['modifier must be an object'] };
    if (!m.key) e.push('missing key');
    if (['flat', 'per_unit', 'multiplier'].indexOf(m.kind) === -1) e.push('kind must be flat/per_unit/multiplier');
    if (m.kind === 'multiplier') {
      if (MULTIPLIER_ALLOWLIST.indexOf(m.key) === -1) e.push('multiplier kind only allowed for ' + MULTIPLIER_ALLOWLIST.join('/'));
      if (num(m.factor) == null) e.push('multiplier requires numeric factor');
    } else {
      if (num(m.amount) == null) e.push(m.kind + ' requires numeric amount');
      if (m.kind === 'per_unit' && !m.unit) e.push('per_unit requires a unit');
    }
    return { ok: e.length === 0, errors: e };
  }

  function stamp(rec, prefix) {
    const t = nowMs();
    rec.id = rec.id || newId(prefix);
    rec.region = rec.region || 'all';
    rec.status = rec.status || 'draft';
    rec.version = rec.version || 1;
    rec.effectiveFrom = rec.effectiveFrom != null ? rec.effectiveFrom : t;
    rec.effectiveTo = rec.effectiveTo != null ? rec.effectiveTo : null;
    rec.createdAt = rec.createdAt || t;
    rec.updatedAt = t;
    return rec;
  }

  // Placeholder rates are NEVER active policy, regardless of declared status.
  function enforcePlaceholderGate(rec) {
    if (rec && rec.source === PLACEHOLDER_SOURCE && rec.status === 'active') rec.status = 'draft';
    return rec;
  }

  // ---- resolution (active policy only; deterministic precedence) ------------
  function isInForce(rec, atMs) {
    if (rec.status !== 'active') return false;
    const from = toMs(rec.effectiveFrom);
    const to = toMs(rec.effectiveTo);
    if (from != null && atMs < from) return false;
    if (to != null && atMs >= to) return false;
    return true;
  }
  // Specificity: region-specific beats 'all'; repairType-specific beats generic.
  // Then newest effectiveFrom, then highest version. A remaining tie is a data
  // defect → caller surfaces a contradiction (never a silent average).
  function pickBest(candidates, region, atMs) {
    const scored = candidates.map(function (c) {
      let spec = 0;
      if (c.region && c.region !== 'all' && c.region === region) spec += 2;
      if (c.repairType) spec += 1;
      return { c: c, spec: spec, from: toMs(c.effectiveFrom) || 0, version: c.version || 0 };
    }).sort(function (a, b) {
      if (b.spec !== a.spec) return b.spec - a.spec;
      if (b.from !== a.from) return b.from - a.from;
      return b.version - a.version;
    });
    if (scored.length === 0) return { rule: null, tie: false };
    const top = scored[0];
    const tie = scored.length > 1 && scored[1].spec === top.spec && scored[1].from === top.from && scored[1].version === top.version;
    return { rule: top.c, tie: tie };
  }

  function resolveRate(itemKey, opts) {
    const o = opts || {};
    const atMs = toMs(o.date) || nowMs();
    const region = o.region || 'all';
    const repairType = o.repairType || null;
    const candidates = vals(RATES).filter(function (r) {
      if (r.itemKey !== itemKey) return false;
      if (!isInForce(r, atMs)) return false;
      if (r.region && r.region !== 'all' && r.region !== region) return false;
      // repairType must match when the spec provides one (and when the rule declares one).
      if (repairType && r.repairType && r.repairType !== repairType) return false;
      if (repairType == null && r.repairType) return false; // a typed rule needs a typed request
      return true;
    });
    return pickBest(candidates, region, atMs);
  }
  function resolveModifier(key, opts) {
    const o = opts || {};
    const atMs = toMs(o.date) || nowMs();
    const region = o.region || 'all';
    const candidates = vals(MODIFIERS).filter(function (m) {
      if (m.key !== key) return false;
      if (!isInForce(m, atMs)) return false;
      if (m.region && m.region !== 'all' && m.region !== region) return false;
      return true;
    });
    return pickBest(candidates, region, atMs);
  }
  function resolveTripMinimum(opts) {
    const o = opts || {};
    const atMs = toMs(o.date) || nowMs();
    const region = o.region || 'all';
    const candidates = vals(TRIP_MINS).filter(function (x) {
      if (!isInForce(x, atMs)) return false;
      if (x.region && x.region !== 'all' && x.region !== region) return false;
      return true;
    });
    return pickBest(candidates, region, atMs);
  }

  // ---- the pricing pipeline -------------------------------------------------
  // base line items → modifiers → subtotal → trip minimum → margin floor →
  // grounding labels + citations + contradictions. Pure and deterministic.
  function price(jobSpec) {
    const spec = jobSpec || {};
    const region = spec.region || 'all';
    const atMs = toMs(spec.date) || nowMs();
    const lines = Array.isArray(spec.lines) ? spec.lines : [];
    const mods = Array.isArray(spec.modifiers) ? spec.modifiers : [];

    const out = {
      lineItems: [], modifierItems: [], subtotal: 0,
      tripMinimumApplied: false, tripMinimumAmount: null, price: 0,
      floor: { marginFloorPct: null, costBasis: null, costBasisSource: null, floorPrice: null, clearsFloor: null, marginAtPrice: null },
      grounding: { price: 'UNGROUNDED', priceReason: '', floor: 'PARTIAL', floorReason: '' },
      citations: [], contradictions: [], resolvedVersions: {}, generatedAt: nowMs()
    };

    let lineSum = 0;
    let anyUnpriced = false;
    let costSum = 0;
    let costKnown = true;       // every priced line had a cost basis
    let costAllMeasured = true; // every priced line used a measured cost basis
    let maxMarginPct = null;

    lines.forEach(function (line, idx) {
      const itemKey = line.itemKey;
      const qty = num(line.qty);
      if (!itemKey || qty == null) { out.contradictions.push({ type: 'INVALID_LINE', index: idx, detail: 'line needs itemKey and numeric qty' }); anyUnpriced = true; return; }
      const res = resolveRate(itemKey, { region: region, date: atMs, repairType: line.repairType });
      if (!res.rule) {
        out.contradictions.push({ type: 'NO_ACTIVE_RATE', itemKey: itemKey, repairType: line.repairType || null, detail: 'no active policy rate — AI must not price this line' });
        anyUnpriced = true;
        return;
      }
      if (res.tie) out.contradictions.push({ type: 'RULE_CONFLICT', itemKey: itemKey, detail: 'multiple equally-specific active rates; resolve the policy data' });
      const rate = res.rule;
      const lineTotal = Math.max(num(rate.baseRate) * qty, num(rate.minCharge) || 0);
      lineSum += lineTotal;
      out.lineItems.push({ itemKey: itemKey, unit: rate.unit, qty: qty, rate: num(rate.baseRate), lineTotal: round(lineTotal), ruleId: rate.id, ruleVersion: rate.version, repairType: rate.repairType || null });
      out.citations.push(rate.id + '@v' + rate.version);
      out.resolvedVersions[itemKey] = rate.version;

      // cost basis accumulation (estimated in Phase A; measured upgrades it in A.5)
      const measured = num(rate.measuredCostBasis);
      const estimated = num(rate.estimatedCostBasis);
      const perUnitCost = measured != null ? measured : estimated;
      if (perUnitCost == null) { costKnown = false; } else { costSum += perUnitCost * qty; if (measured == null) costAllMeasured = false; }
      const mf = marginFraction(rate.marginFloorPct);
      if (mf != null) maxMarginPct = maxMarginPct == null ? mf : Math.max(maxMarginPct, mf);
    });

    // ---- modifiers: explicit flat/per_unit adds, then allowlisted multipliers
    let flatAdds = 0;
    let multiplierFactor = 1;
    mods.forEach(function (m, idx) {
      const key = m && m.key;
      if (!key) { out.contradictions.push({ type: 'INVALID_MODIFIER', index: idx }); return; }
      const res = resolveModifier(key, { region: region, date: atMs });
      if (!res.rule) { out.contradictions.push({ type: 'NO_ACTIVE_MODIFIER', key: key, detail: 'modifier not in active policy — not applied' }); return; }
      if (res.tie) out.contradictions.push({ type: 'MODIFIER_CONFLICT', key: key });
      const mod = res.rule;
      let applied;
      if (mod.kind === 'multiplier') { multiplierFactor *= num(mod.factor); applied = { key: key, kind: 'multiplier', factor: num(mod.factor) }; }
      else if (mod.kind === 'per_unit') { const q = num(m.qty) || 0; const add = num(mod.amount) * q; flatAdds += add; applied = { key: key, kind: 'per_unit', unit: mod.unit, qty: q, amount: num(mod.amount), add: round(add) }; }
      else { flatAdds += num(mod.amount); applied = { key: key, kind: 'flat', amount: num(mod.amount), add: round(num(mod.amount)) }; }
      applied.ruleId = mod.id; applied.ruleVersion = mod.version;
      out.modifierItems.push(applied);
      out.citations.push('mod:' + mod.id + '@v' + mod.version);
      out.resolvedVersions['mod:' + key] = mod.version;
    });

    const subtotal = round((lineSum + flatAdds) * multiplierFactor);
    out.subtotal = subtotal;

    // ---- trip minimum (modifiers count toward clearing it) ----
    const tm = resolveTripMinimum({ region: region, date: atMs });
    let charge = subtotal;
    if (tm.rule) {
      out.tripMinimumAmount = num(tm.rule.amount);
      out.citations.push('tripmin:' + tm.rule.id + '@v' + tm.rule.version);
      out.resolvedVersions['tripMinimum'] = tm.rule.version;
      if (subtotal < out.tripMinimumAmount) { charge = out.tripMinimumAmount; out.tripMinimumApplied = true; }
    }
    out.price = round(charge);

    // ---- margin floor (price-based gross margin: floor = cost / (1 - m)) ----
    out.floor.marginFloorPct = maxMarginPct;
    if (costKnown && costSum >= 0 && !anyUnpriced && out.lineItems.length) {
      out.floor.costBasis = round(costSum);
      out.floor.costBasisSource = costAllMeasured ? 'measured' : 'estimated';
      if (maxMarginPct != null && maxMarginPct < 1) {
        const floorPrice = costSum / (1 - maxMarginPct);
        out.floor.floorPrice = round(floorPrice);
        out.floor.clearsFloor = charge >= floorPrice;
        out.floor.marginAtPrice = charge > 0 ? round((charge - costSum) / charge, 4) : null;
        if (!out.floor.clearsFloor) {
          // If even the trip minimum can't clear the floor, the job is structurally unprofitable.
          out.contradictions.push({
            type: out.tripMinimumApplied ? 'MINIMUM_BELOW_FLOOR' : 'BELOW_MARGIN_FLOOR',
            detail: 'price ' + out.price + ' is below margin floor ' + out.floor.floorPrice + ' (cost ' + out.floor.costBasis + ' @ ' + Math.round(maxMarginPct * 100) + '% target)'
          });
        }
      } else if (maxMarginPct != null) {
        out.contradictions.push({ type: 'INVALID_MARGIN', detail: 'marginFloorPct >= 1 is not a valid gross margin' });
      }
    } else if (anyUnpriced) {
      out.floor.floorReason = 'floor not computed: one or more lines have no active rate';
    } else {
      out.contradictions.push({ type: 'NO_COST_BASIS', detail: 'no cost basis on priced lines — floor cannot be verified' });
      out.floor.floorReason = 'no cost basis available';
    }

    // ---- grounding labels (honest about what Phase A can know) ----
    // Price grounding: Phase A ceiling is PARTIAL (rule exists, no comps yet).
    // GROUNDED is reserved for Phase B when strong comps attach.
    if (anyUnpriced) {
      out.grounding.price = 'UNGROUNDED';
      out.grounding.priceReason = 'no active price rule for one or more lines; AI must not price — human decides';
    } else {
      out.grounding.price = 'PARTIAL';
      out.grounding.priceReason = 'priced from active policy rules; comparable jobs not yet evaluated (Phase B)';
    }
    // Floor grounding: PARTIAL on estimated cost, GROUNDED on measured cost (A.5).
    if (out.floor.costBasisSource === 'measured') {
      out.grounding.floor = 'GROUNDED';
      out.grounding.floorReason = 'floor from measured labor/material cost';
    } else {
      out.grounding.floor = 'PARTIAL';
      out.grounding.floorReason = out.floor.floorReason || 'floor from estimated cost basis; job costing not yet applied (Phase A.5)';
    }

    return out;
  }

  // ---- public API -----------------------------------------------------------
  const Store = {
    UNITS: UNITS.slice(),
    SERVICE_CATEGORIES: SERVICE_CATEGORIES.slice(),
    MULTIPLIER_ALLOWLIST: MULTIPLIER_ALLOWLIST.slice(),
    PLACEHOLDER_SOURCE: PLACEHOLDER_SOURCE,
    validateRate: validateRate,
    validateModifier: validateModifier,

    // rates
    createRate: function (input) {
      const v = validateRate(input || {});
      if (!v.ok) return { ok: false, error: 'VALIDATION_FAILED', errors: v.errors };
      const rec = enforcePlaceholderGate(stamp(Object.assign({}, input), 'rate'));
      RATES[rec.id] = rec; persist();
      return { ok: true, rate: rec };
    },
    updateRate: function (id, patch) {
      const cur = RATES[id]; if (!cur) return { ok: false, error: 'NOT_FOUND' };
      const next = enforcePlaceholderGate(Object.assign({}, cur, patch || {}, { updatedAt: nowMs() }));
      const v = validateRate(next); if (!v.ok) return { ok: false, error: 'VALIDATION_FAILED', errors: v.errors };
      RATES[id] = next; persist(); return { ok: true, rate: next };
    },
    getRate: function (id) { return RATES[id] || null; },
    listRates: function (filter) {
      const f = filter || {};
      return vals(RATES).filter(function (r) {
        if (!f.includeArchived && r.status === 'archived') return false;
        if (f.status && r.status !== f.status) return false;
        if (f.serviceCategory && r.serviceCategory !== f.serviceCategory) return false;
        if (f.itemKey && r.itemKey !== f.itemKey) return false;
        return true;
      });
    },
    archiveRate: function (id) { const r = RATES[id]; if (!r) return { ok: false, error: 'NOT_FOUND' }; r.status = 'archived'; r.updatedAt = nowMs(); persist(); return { ok: true, rate: r }; },

    // modifiers
    createModifier: function (input) {
      const v = validateModifier(input || {});
      if (!v.ok) return { ok: false, error: 'VALIDATION_FAILED', errors: v.errors };
      const rec = enforcePlaceholderGate(stamp(Object.assign({}, input), 'mod'));
      MODIFIERS[rec.id] = rec; persist(); return { ok: true, modifier: rec };
    },
    listModifiers: function (filter) {
      const f = filter || {};
      return vals(MODIFIERS).filter(function (m) { if (!f.includeArchived && m.status === 'archived') return false; if (f.status && m.status !== f.status) return false; return true; });
    },

    // trip minimums
    createTripMinimum: function (input) {
      if (num((input || {}).amount) == null) return { ok: false, error: 'VALIDATION_FAILED', errors: ['amount must be numeric'] };
      const rec = enforcePlaceholderGate(stamp(Object.assign({}, input), 'tripmin'));
      TRIP_MINS[rec.id] = rec; persist(); return { ok: true, tripMinimum: rec };
    },
    listTripMinimums: function () { return vals(TRIP_MINS); },

    // resolution (exposed for tests / explainability)
    resolveRate: resolveRate,
    resolveModifier: resolveModifier,
    resolveTripMinimum: resolveTripMinimum,

    /** Compute a priced DRAFT (never a committed price). The core API. */
    price: price,

    /**
     * Ingest a seed policy document ({ rates, modifiers, tripMinimums }).
     * Placeholder-sourced records are forced to draft (never active policy).
     */
    loadSeed: function (seed) {
      const s = seed || {};
      const out = { ok: true, rates: 0, modifiers: 0, tripMinimums: 0, skipped: [] };
      (s.rates || []).forEach(function (raw) {
        const v = validateRate(raw); if (!v.ok) { out.skipped.push({ id: raw && raw.id, errors: v.errors }); return; }
        const rec = enforcePlaceholderGate(stamp(Object.assign({}, raw), 'rate')); RATES[rec.id] = rec; out.rates++;
      });
      (s.modifiers || []).forEach(function (raw) {
        const v = validateModifier(raw); if (!v.ok) { out.skipped.push({ id: raw && raw.id, errors: v.errors }); return; }
        const rec = enforcePlaceholderGate(stamp(Object.assign({}, raw), 'mod')); MODIFIERS[rec.id] = rec; out.modifiers++;
      });
      (s.tripMinimums || []).forEach(function (raw) {
        if (num(raw && raw.amount) == null) { out.skipped.push({ id: raw && raw.id, errors: ['amount must be numeric'] }); return; }
        const rec = enforcePlaceholderGate(stamp(Object.assign({}, raw), 'tripmin')); TRIP_MINS[rec.id] = rec; out.tripMinimums++;
      });
      persist();
      return out;
    },

    /** Test/util: wipe the in-memory policy. */
    _clear: function () { RATES = {}; MODIFIERS = {}; TRIP_MINS = {}; persist(); return { ok: true }; }
  };

  try { hydrate(); } catch (_) {}

  global.AAA_PRICE_BOOK = Store;
})(typeof window !== 'undefined' ? window : this);
