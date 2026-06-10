/*
 * Price Book — canonical, margin-floored rate catalog → priced draft.
 * Verifies the governance decisions (price-based floor, flat/per-unit by
 * default, multiplier whitelist, modifiers→trip minimum, shampoo-only real
 * rate, draft placeholders), every required output, and the HARD FIREWALL
 * (no reads of outcomes / quotes / comps) both statically and at runtime.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('price-book');
  const { G } = setupEnv({ fixedISO: '2026-06-10T00:00:00Z' });
  load('js/intelligence/price-book.js');
  const PB = G.AAA_PRICE_BOOK;

  // ── catalog: only shampoo is a confirmed, active, real rate ───────────────
  const cat = PB.catalog();
  t.eq('shampoo is the one real rate: $45/room active', cat.services.shampoo.rate, 45);
  t.ok('shampoo active + owner-confirmed', cat.services.shampoo.status === 'active' && cat.services.shampoo.confirmed === true && cat.services.shampoo.unit === 'room');
  t.ok('every other service is a draft placeholder', Object.keys(cat.services).filter((k) => k !== 'shampoo').every((k) => cat.services[k].status === 'draft' && cat.services[k].confirmed === false));
  t.ok('draftEntries lists the unknowns for owner review', PB.draftEntries().some((e) => e.code === 'steam_clean' && e.kind === 'service') && PB.draftEntries().every((e) => e.confirmed !== true));

  // ── multiplier whitelist invariant ───────────────────────────────────────
  t.ok('only the four sanctioned multipliers exist as multipliers', ['HEAVY_SOIL', 'AFTER_HOURS', 'EMERGENCY_SERVICE', 'COMMERCIAL'].every((c) => cat.modifiers[c].kind === 'multiplier'));
  t.ok('other modifiers are flat / per-unit by default', cat.modifiers.STAIRS.kind === 'per_unit' && cat.modifiers.FURNITURE_MOVE.kind === 'flat');
  t.ok('canonical catalog validates clean', PB.validateCatalog().ok === true && PB.validateCatalog().violations.length === 0);
  // tamper: a non-whitelisted modifier declared as a multiplier is illegal
  const bad = PB.catalog(); bad.modifiers.STAIRS.kind = 'multiplier'; bad.modifiers.STAIRS.factor = 1.5;
  const v1 = PB.validateCatalog(bad);
  t.ok('illegal multiplier rejected', v1.ok === false && v1.violations.some((x) => x.code === 'STAIRS' && x.error === 'ILLEGAL_MULTIPLIER'));
  const bad2 = PB.catalog(); bad2.modifiers.HEAVY_SOIL.kind = 'flat';
  t.ok('whitelisted-but-not-multiplier rejected', PB.validateCatalog(bad2).violations.some((x) => x.error === 'WHITELISTED_NOT_MULTIPLIER'));

  // ── happy path: shampoo only, above trip minimum → clean priced draft ─────
  const a = PB.price({ items: [{ service: 'shampoo', qty: 4 }] });
  t.eq('4 rooms shampoo prices at $180', a.price, 180);
  t.eq('status priced (no review needed)', a.status, 'priced');
  t.ok('no owner review for the one confirmed rate', a.requiresOwnerReview === false && a.contradictions.length === 0);
  t.eq('margin floor is price-based ($30/room × 4)', a.marginFloor, 120);
  t.ok('one line item, no modifiers', a.lineItems.length === 1 && a.modifierItems.length === 0);
  t.ok('line item grounded + cited', a.lineItems[0].grounding.indexOf('owner-confirmed') !== -1 && a.lineItems[0].citationId === 'cite:service:shampoo:v1');
  t.ok('draftId + at stamped', !!a.draftId && a.at === '2026-06-10T00:00:00Z');

  // ── trip minimum binds when subtotal is below it ──────────────────────────
  const b = PB.price({ items: [{ service: 'shampoo', qty: 1 }] });
  t.ok('1 room ($45) bumped to trip minimum $150', b.price === 150 && b.tripMinimumApplied === true && b.tripMinimumAdjustment === 105);
  t.eq('still priced (trip minimum is confirmed policy)', b.status, 'priced');

  // ── modifiers COUNT TOWARD the trip minimum ───────────────────────────────
  const noMod = PB.price({ items: [{ service: 'shampoo', qty: 3 }] });                                   // 135 < 150 → applies
  const withMod = PB.price({ items: [{ service: 'shampoo', qty: 3 }], modifiers: [{ code: 'FURNITURE_MOVE' }] }); // 135+40=175 → clears
  t.ok('without modifier, 3 rooms ($135) is below trip min', noMod.tripMinimumApplied === true);
  t.ok('modifier counts toward trip min and clears it', withMod.price === 175 && withMod.tripMinimumApplied === false && withMod.modifierItems[0].countsTowardTripMinimum === true);

  // ── multiplier math: HEAVY_SOIL scales the service subtotal AND the floor ─
  const hs = PB.price({ items: [{ service: 'shampoo', qty: 4 }], modifiers: ['HEAVY_SOIL'] });
  t.ok('HEAVY_SOIL ×1.30 → price 234, uplift 54', hs.price === 234 && hs.modifierItems[0].amount === 54 && hs.modifierItems[0].kind === 'multiplier');
  t.eq('margin floor scaled by the multiplier ($120 × 1.30)', hs.marginFloor, 156);
  t.ok('using a draft modifier flags review', hs.requiresOwnerReview === true && hs.contradictions.some((c) => c.code === 'DRAFT_MODIFIER_PLACEHOLDER') && hs.contradictions.some((c) => c.code === 'FLOOR_NOT_CONFIRMED'));

  // ── per-unit modifier: STAIRS $5/step × 12 = $60 added ────────────────────
  const st = PB.price({ items: [{ service: 'shampoo', qty: 1 }], modifiers: [{ code: 'STAIRS', qty: 12 }] });
  t.ok('STAIRS per-unit adds $60 (counts toward trip min)', st.modifierItems[0].amount === 60 && st.modifierItems[0].qty === 12);
  t.eq('floor includes additive modifier floor ($30 + $3×12)', st.marginFloor, 66);

  // ── draft service placeholder requires owner review ───────────────────────
  const dr = PB.price({ items: [{ service: 'steam_clean', qty: 2 }] });
  t.ok('draft service flagged for owner review', dr.status === 'draft_review_required' && dr.contradictions.some((c) => c.code === 'DRAFT_RATE_PLACEHOLDER'));

  // ── unknown service → contradiction, not a silent price ───────────────────
  const uk = PB.price({ items: [{ service: 'gold_plating', qty: 1 }] });
  t.ok('unknown service surfaces a contradiction', uk.contradictions.some((c) => c.code === 'UNKNOWN_SERVICE') && uk.lineItems[0].status === 'unknown' && uk.lineItems[0].amount === 0);

  // ── every required output is present and well-formed ──────────────────────
  t.ok('priced draft has all required outputs', ['lineItems', 'modifierItems', 'tripMinimum', 'marginFloor', 'priceGrounding', 'floorGrounding', 'citations', 'contradictions', 'resolvedVersions'].every((k) => k in hs));
  t.ok('price grounding explains the method + numbers', /trip minimum/.test(hs.priceGrounding.method) && hs.priceGrounding.multiplierFactor === 1.3 && hs.priceGrounding.serviceSubtotal === 180);
  t.ok('floor grounding affirms it is NOT from outcomes/quotes', /NEVER derived from outcomes/.test(hs.floorGrounding.method) && hs.floorGrounding.confirmed === false);
  t.ok('citations reference catalog versions', hs.citations.some((c) => c.code === 'shampoo' && c.confirmed === true) && hs.citations.some((c) => c.kind === 'trip_minimum'));
  t.ok('resolved versions pin every entry used', hs.resolvedVersions.catalog === 1 && hs.resolvedVersions.entries.shampoo === 1 && hs.resolvedVersions.entries.HEAVY_SOIL === 1);

  // ── HARD FIREWALL — static: the source reads no history at all ─────────────
  const src = fs.readFileSync(path.join(ROOT, 'js/intelligence/price-book.js'), 'utf8');
  ['AAA_OUTCOME_SPINE', 'AAA_QUOTES', 'AAA_QUOTE_COMPS', 'AAA_DATA', 'AAA_MEASUREMENT_QUOTE'].forEach((forbidden) => {
    t.ok('firewall: source never references ' + forbidden, src.indexOf(forbidden) === -1);
  });
  t.ok('firewall: source reads no outcomes/quotes/comparables collections', !/list\(\s*['"](outcomes|quotes|outcome_labels)['"]/.test(src));

  // ── HARD FIREWALL — runtime: history globals throw if touched ──────────────
  const tripwire = (name) => new Proxy({}, { get() { throw new Error('FIREWALL BREACH: Price Book touched ' + name); } });
  G.AAA_OUTCOME_SPINE = tripwire('AAA_OUTCOME_SPINE');
  G.AAA_QUOTES = tripwire('AAA_QUOTES');
  G.AAA_QUOTE_COMPS = tripwire('AAA_QUOTE_COMPS');
  G.AAA_DATA = tripwire('AAA_DATA');
  let firewallHeld = true, firePrice = null;
  try { firePrice = PB.price({ items: [{ service: 'shampoo', qty: 4 }], modifiers: ['HEAVY_SOIL'] }); PB.validateCatalog(); PB.catalog(); PB.draftEntries(); }
  catch (_) { firewallHeld = false; }
  t.ok('firewall holds: pricing works with history globals booby-trapped', firewallHeld === true && firePrice && firePrice.price === 234);

  return t.report();
};
