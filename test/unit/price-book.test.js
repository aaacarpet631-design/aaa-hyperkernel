/*
 * AAA_PRICE_BOOK — pricing-policy engine unit tests.
 *
 * Covers the FIREWALL invariant (no history/comps reads), rate/modifier
 * validation, the multiplier allowlist, the placeholder→draft gate,
 * deterministic resolution precedence (region / version / effective date /
 * repairType / tie), the full pricing pipeline (lines → modifiers → subtotal →
 * trip minimum → price-based margin floor), both grounding axes, the required
 * priced-draft fields, and the synthetic seed. Pure, deterministic, no network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('price-book');
  const { G } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });
  load('js/intelligence/price-book-store.js');
  const PB = G.AAA_PRICE_BOOK;
  t.ok('global exists', !!PB);
  PB._clear();

  // ---- FIREWALL invariant: policy must not read history/evidence -----------
  // Scan CODE only (comments stripped) — the docstring legitimately names these
  // globals to explain the firewall; what matters is that the code never reads them.
  const rawSrc = fs.readFileSync(path.join(ROOT, 'js/intelligence/price-book-store.js'), 'utf8');
  const code = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  t.ok('firewall: code does not reference AAA_OUTCOME_SPINE', !/AAA_OUTCOME_SPINE/.test(code));
  t.ok('firewall: code does not reference AAA_QUOTES', !/AAA_QUOTES/.test(code));
  t.ok('firewall: code does not reference AAA_QUOTE_COMPS', !/AAA_QUOTE_COMPS/.test(code));
  t.ok('firewall: code does not read historical outcomes', !/list\(\s*['"]outcomes['"]/.test(code));

  // ---- validation -----------------------------------------------------------
  t.eq('invalid rate fails validation', PB.createRate({ title: 'nope' }).ok, false);
  t.eq('valid rate created', PB.createRate({ serviceCategory: 'cleaning', itemKey: 'x', unit: 'PER_ROOM', baseRate: 10, marginFloorPct: 0.3, status: 'active' }).ok, true);

  // multiplier allowlist
  t.eq('multiplier allowed for HEAVY_SOIL', PB.validateModifier({ key: 'HEAVY_SOIL', kind: 'multiplier', factor: 1.25 }).ok, true);
  t.eq('multiplier rejected for STAIRS', PB.validateModifier({ key: 'STAIRS', kind: 'multiplier', factor: 1.2 }).ok, false);
  t.eq('STAIRS valid as per_unit', PB.validateModifier({ key: 'STAIRS', kind: 'per_unit', unit: 'STAIR', amount: 3 }).ok, true);

  // ---- placeholder gate -----------------------------------------------------
  const ph = PB.createRate({ serviceCategory: 'repair', itemKey: 'repair', repairType: 'burn', unit: 'PER_REPAIR', baseRate: 120, marginFloorPct: 0.35, status: 'active', source: PB.PLACEHOLDER_SOURCE });
  t.eq('placeholder cannot be active policy', ph.rate.status, 'draft');

  // ---- resolution precedence ------------------------------------------------
  PB._clear();
  PB.createRate({ id: 'r_all', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 45, marginFloorPct: 0.3, region: 'all', status: 'active', version: 1 });
  PB.createRate({ id: 'r_tx', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 50, marginFloorPct: 0.3, region: 'TX', status: 'active', version: 1 });
  t.eq('region-specific beats all', PB.resolveRate('shampoo_room', { region: 'TX' }).rule.id, 'r_tx');
  t.eq('falls back to all for other region', PB.resolveRate('shampoo_room', { region: 'CA' }).rule.id, 'r_all');
  PB.createRate({ id: 'r_all_v2', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 48, marginFloorPct: 0.3, region: 'all', status: 'active', version: 2 });
  t.eq('newest version wins', PB.resolveRate('shampoo_room', { region: 'CA' }).rule.id, 'r_all_v2');
  // future-dated rate is dormant
  PB.createRate({ id: 'r_future', serviceCategory: 'cleaning', itemKey: 'future_only', unit: 'PER_ROOM', baseRate: 99, marginFloorPct: 0.3, status: 'active', effectiveFrom: '2099-01-01T00:00:00Z' });
  t.eq('future-dated rate not yet in force', PB.resolveRate('future_only', {}).rule, null);
  // repairType discrimination
  PB.createRate({ id: 'r_burn', serviceCategory: 'repair', itemKey: 'repair', repairType: 'burn', unit: 'PER_REPAIR', baseRate: 120, marginFloorPct: 0.35, status: 'active' });
  t.eq('repairType resolves typed rate', PB.resolveRate('repair', { repairType: 'burn' }).rule.id, 'r_burn');
  t.eq('typed rule needs typed request', PB.resolveRate('repair', {}).rule, null);
  // tie → flagged
  PB.createRate({ id: 'r_tie_a', serviceCategory: 'cleaning', itemKey: 'tie_item', unit: 'PER_ROOM', baseRate: 10, marginFloorPct: 0.3, status: 'active', version: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
  PB.createRate({ id: 'r_tie_b', serviceCategory: 'cleaning', itemKey: 'tie_item', unit: 'PER_ROOM', baseRate: 12, marginFloorPct: 0.3, status: 'active', version: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
  t.eq('equal-specificity tie detected', PB.resolveRate('tie_item', {}).tie, true);

  // ---- pricing pipeline: happy path ----------------------------------------
  PB._clear();
  PB.createRate({ id: 'shampoo', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 45, estimatedCostBasis: 15, marginFloorPct: 0.30, status: 'active' });
  const d = PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 3 }] });
  t.eq('subtotal = rate × qty', d.subtotal, 135);
  t.eq('price = subtotal (no trip min)', d.price, 135);
  t.eq('cost basis summed', d.floor.costBasis, 45);
  t.eq('price-based floor = cost/(1-m)', d.floor.floorPrice, 64.29); // 45 / 0.70
  t.eq('clears floor', d.floor.clearsFloor, true);
  t.eq('margin at price', d.floor.marginAtPrice, 0.6667);
  t.eq('price grounding PARTIAL (no comps in Phase A)', d.grounding.price, 'PARTIAL');
  t.eq('floor grounding PARTIAL (estimated cost)', d.grounding.floor, 'PARTIAL');
  t.ok('citations present', d.citations.indexOf('shampoo@v1') !== -1);
  t.ok('resolvedVersions present', d.resolvedVersions.shampoo_room === 1);

  // required fields on every draft
  ['grounding', 'citations', 'contradictions', 'resolvedVersions', 'floor'].forEach(function (k) { t.ok('draft has ' + k, d[k] !== undefined); });
  t.ok('grounding has both axes', d.grounding.price !== undefined && d.grounding.floor !== undefined);

  // ---- measured cost basis → GROUNDED floor (A.5 path) ----------------------
  PB._clear();
  PB.createRate({ id: 'm', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 45, estimatedCostBasis: 15, measuredCostBasis: 16, marginFloorPct: 0.30, status: 'active' });
  t.eq('measured cost → floor GROUNDED', PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 1 }] }).grounding.floor, 'GROUNDED');

  // ---- modifiers: flat + per_unit + allowlisted multiplier ------------------
  PB._clear();
  PB.createRate({ id: 'shampoo', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 45, estimatedCostBasis: 15, marginFloorPct: 0.30, status: 'active' });
  PB.createModifier({ id: 'furniture', key: 'FURNITURE_MOVE', kind: 'flat', amount: 25, status: 'active' });
  PB.createModifier({ id: 'heavy', key: 'HEAVY_SOIL', kind: 'multiplier', factor: 1.25, status: 'active' });
  const dm = PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 3 }], modifiers: [{ key: 'FURNITURE_MOVE' }, { key: 'HEAVY_SOIL' }] });
  t.eq('subtotal = (lines + flat) × multiplier', dm.subtotal, 200); // (135 + 25) × 1.25
  t.eq('modifier citations recorded', dm.citations.indexOf('mod:furniture@v1') !== -1, true);

  // ---- trip minimum: counts modifiers, lifts small jobs ---------------------
  PB._clear();
  PB.createRate({ id: 'shampoo', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 45, estimatedCostBasis: 15, marginFloorPct: 0.30, status: 'active' });
  PB.createTripMinimum({ id: 'tm', region: 'all', amount: 99, status: 'active' });
  const dt = PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 1 }] }); // subtotal 45 < 99
  t.eq('trip minimum applied', dt.tripMinimumApplied, true);
  t.eq('price lifted to trip minimum', dt.price, 99);

  // ---- structural unprofitability: minimum still below floor ----------------
  PB._clear();
  PB.createRate({ id: 'pricey', serviceCategory: 'repair', itemKey: 'repair', repairType: 'seam', unit: 'PER_REPAIR', baseRate: 10, estimatedCostBasis: 90, marginFloorPct: 0.30, status: 'active' });
  PB.createTripMinimum({ id: 'tm', region: 'all', amount: 99, status: 'active' });
  const du = PB.price({ lines: [{ itemKey: 'repair', repairType: 'seam', qty: 1 }] }); // charge 99, floor 90/0.7=128.57
  t.ok('minimum-below-floor contradiction', du.contradictions.some(function (c) { return c.type === 'MINIMUM_BELOW_FLOOR'; }));
  t.eq('floor not cleared', du.floor.clearsFloor, false);

  // ---- below margin floor (no trip min) -------------------------------------
  PB._clear();
  PB.createRate({ id: 'thin', serviceCategory: 'cleaning', itemKey: 'shampoo_room', unit: 'PER_ROOM', baseRate: 50, estimatedCostBasis: 45, marginFloorPct: 0.30, status: 'active' });
  const db = PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 1 }] }); // 50 < 45/0.7 = 64.29
  t.ok('below-margin-floor contradiction', db.contradictions.some(function (c) { return c.type === 'BELOW_MARGIN_FLOOR'; }));

  // ---- UNGROUNDED: no active rate → AI must not price -----------------------
  PB._clear();
  const dn = PB.price({ lines: [{ itemKey: 'unknown_service', qty: 2 }] });
  t.eq('price grounding UNGROUNDED', dn.grounding.price, 'UNGROUNDED');
  t.ok('NO_ACTIVE_RATE contradiction', dn.contradictions.some(function (c) { return c.type === 'NO_ACTIVE_RATE'; }));

  // ---- seed ingestion: known active, placeholders draft ---------------------
  PB._clear();
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/price-book.seed.json'), 'utf8'));
  const loaded = PB.loadSeed(seed);
  t.ok('seed rates loaded', loaded.rates > 0);
  t.eq('only known shampoo rate is active', PB.listRates({ status: 'active' }).length, 1);
  t.eq('active rate is the $45 shampoo', PB.listRates({ status: 'active' })[0].itemKey, 'shampoo_room');
  t.ok('placeholder rates remain draft', PB.listRates({ includeArchived: true }).filter(function (r) { return r.source === PB.PLACEHOLDER_SOURCE; }).every(function (r) { return r.status === 'draft'; }));
  // seeded shampoo prices (PARTIAL); a draft-only service does not price
  t.eq('seeded shampoo prices', PB.price({ lines: [{ itemKey: 'shampoo_room', qty: 2 }] }).price, 90);
  t.eq('draft-only service is UNGROUNDED', PB.price({ lines: [{ itemKey: 'stretch_room', qty: 1 }] }).grounding.price, 'UNGROUNDED');

  return t.report();
};
