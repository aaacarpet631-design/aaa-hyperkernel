/*
 * Pricing Resolver — deterministic evidence → price decision.
 * Verifies every hard rule, the evidence-resolution model, flags, confidence,
 * and the immutable-ledger write. Pure compute() + ledger-backed resolve().
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('pricing-resolver');
  const { G } = setupEnv({});
  load('js/intelligence/pricing-resolver.js');
  const R = G.AAA_PRICING_RESOLVER;

  const comps = (won, lost) => ({ comparables: [].concat(
    won.map((a) => ({ amount: a, outcome: 'won' })), (lost || []).map((a) => ({ amount: a, outcome: 'lost' }))
  ) });

  // ---- required inputs ----------------------------------------------------
  t.eq('anchor required', R.compute({ marginFloor: 1400 }).error, 'ANCHOR_REQUIRED');
  t.eq('margin floor required', R.compute({ anchor: { price: 1450 } }).error, 'MARGIN_FLOOR_REQUIRED');

  // ---- THE WORKED EXAMPLE: band entirely below floor → UNPROFITABLE -------
  // anchor 2000, floor 1400, winning band 1250-1350 (below floor).
  const ex = R.compute({ anchor: { price: 2000 }, marginFloor: 1400, signals: comps([1250, 1300, 1350], [1500, 1600]) });
  t.eq('recommended is the floor (lowest defensible)', ex.recommended, 1400);
  t.ok('UNPROFITABLE_TO_WIN emitted', ex.escalationFlags.indexOf('UNPROFITABLE_TO_WIN') !== -1 && ex.unprofitableToWin === true);
  t.ok('never below floor', ex.recommended >= 1400);
  t.ok('requires review + approval', ex.requiresReview === true && ex.requiresApproval === true);
  // HARD RULE #2: NOT an average of constraints + signals (avg(2000,1300,1400)=1566.67)
  t.ok('did NOT average (floor clamp, not blend)', ex.recommended !== Math.round((2000 + 1300 + 1400) / 3) && ex.recommended === 1400);
  t.ok('supervisor options surface the strategic choice', ex.supervisorReviewPayload.options.length === 3 && /unprofitable|floor/i.test(ex.supervisorReviewPayload.options.join(' ')));

  // ---- normal in-range band (below anchor) → nudge within feasible -------
  const norm = R.compute({ anchor: { price: 1500, active: true }, marginFloor: 1200, signals: comps([1300, 1320, 1340, 1360, 1380, 1400, 1350, 1370]) });
  t.ok('recommended inside feasible range', norm.recommended >= norm.feasibleRange.low && norm.recommended <= norm.feasibleRange.high);
  t.ok('recommended >= floor, <= anchor (nudged down toward winning band)', norm.recommended >= 1200 && norm.recommended <= 1500);
  t.ok('no unprofitable flag for in-range band', norm.escalationFlags.indexOf('UNPROFITABLE_TO_WIN') === -1);
  t.eq('confident, no review needed', norm.confidenceLevel, 'high');
  t.ok('not flagged for review', norm.requiresReview === false);

  // ---- HARD RULE #1: never below floor, even with extreme low signal -----
  const extreme = R.compute({ anchor: { price: 1500 }, marginFloor: 1450, signals: comps([200, 300, 250, 400, 350, 300]) });
  t.ok('extreme low signal still >= floor', extreme.recommended >= 1450 && extreme.recommended === 1450 && extreme.unprofitableToWin === true);

  // ---- feasible range top = anchor + uplift; opportunity band above ------
  const opp = R.compute({ anchor: { price: 1400 }, marginFloor: 1200, signals: comps([1700, 1800, 1750, 1720, 1780, 1760]) });
  t.ok('recommended capped at feasible high (uplift)', opp.recommended <= opp.feasibleRange.high && opp.feasibleRange.high === Math.round(1400 * 1.2));

  // ---- THIN_DATA leans to the anchor -------------------------------------
  const thin = R.compute({ anchor: { price: 1400 }, marginFloor: 1200, signals: comps([1300, 1320]) });
  t.ok('thin data flagged', thin.escalationFlags.indexOf('THIN_DATA') !== -1);
  t.ok('thin data → stays near anchor (small move)', Math.abs(thin.recommended - 1400) < 60 && thin.requiresReview === true);

  // ---- LARGE_DEVIATION ----------------------------------------------------
  const dev = R.compute({ anchor: { price: 2000 }, marginFloor: 1000, signals: comps([1200, 1250, 1300, 1220, 1280, 1260, 1240, 1300, 1210, 1290, 1230, 1270, 1255, 1245, 1265, 1235, 1275, 1225, 1285, 1215]) });
  t.ok('large deviation from anchor flagged', dev.escalationFlags.indexOf('LARGE_DEVIATION') !== -1 && dev.recommended >= 1000);

  // ---- CONTRADICTORY_SIGNAL ----------------------------------------------
  const contra = R.compute({ anchor: { price: 1400 }, marginFloor: 1200, signals: comps([1300, 1500], [1350, 1450]) });
  t.ok('overlapping win/loss → contradictory', contra.escalationFlags.indexOf('CONTRADICTORY_SIGNAL') !== -1);

  // ---- price book below floor (misconfig) --------------------------------
  const mis = R.compute({ anchor: { price: 1300 }, marginFloor: 1400, signals: comps([1380, 1390, 1395, 1385, 1392, 1388]) });
  t.ok('pricebook-below-floor flagged + clamped up', mis.escalationFlags.indexOf('PRICEBOOK_BELOW_FLOOR') !== -1 && mis.recommended >= 1400);

  // ---- floor below material cost -----------------------------------------
  const fbc = R.compute({ material: { cost: 1500 }, anchor: { price: 1800 }, marginFloor: 1400, signals: comps([1700, 1750, 1720, 1760, 1740, 1730]) });
  t.ok('floor below cost flagged', fbc.escalationFlags.indexOf('FLOOR_BELOW_COST') !== -1);

  // ---- evidence package completeness -------------------------------------
  t.ok('evidence has anchor/floor/signal/weighting', !!norm.evidence.anchor && norm.evidence.marginFloor === 1200 && !!norm.evidence.signal.winningBand && /never averaged/.test(norm.evidence.weighting.method));

  // ---- HARD RULE #4: customer-facing always requires approval ------------
  t.ok('every decision requires approval', [ex, norm, extreme, opp, thin, dev, contra, mis, fbc].every((d) => d.requiresApproval === true));

  // ---- HARD RULE #5: resolve() writes to the immutable ledger -------------
  load('js/governance/audit-ledger.js');
  const L = G.AAA_AUDIT_LEDGER;
  const resolved = await R.resolve({ anchor: { price: 1500 }, marginFloor: 1200, signals: comps([1300, 1320, 1340, 1360, 1380, 1400]), meta: { agentId: 'estimator', subjectType: 'quote', subjectId: 'q42', jobId: 'j7' } });
  t.ok('resolve returns decisionId + ledgerRef', !!resolved.decisionId && !!resolved.ledgerRef);
  const chain = await L.chain();
  const led = chain.find((e) => e.type === 'pricing_decision' && e.payload.decisionId === resolved.decisionId);
  t.ok('ledger entry written', !!led && led.payload.recommended === resolved.recommended && led.payload.marginFloor === 1200);
  t.ok('ledger entry is PII-free (ids + numbers only)', !!led && JSON.stringify(led.payload).indexOf('@') === -1 && led.payload.subjectId === 'q42');
  t.ok('audit ledger verifies', (await L.verify()).ok === true);

  return t.report();
};
