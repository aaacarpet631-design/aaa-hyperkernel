/* Seam & Layout Optimizer — carpet-specific layout intelligence: 12-ft roll,
 * nap consistency (no rotation), main-drop + fill, fill harvesting, waste %,
 * seam risk, insufficient geometry, review gating, append-only store, no quote
 * mutation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/measurements/models/measurement-models.js', 'js/measurements/storage/measurement-store.js',
   'js/field/layout-constraint-engine.js', 'js/field/cut-list-generator.js', 'js/field/layout-risk-analyzer.js',
   'js/field/layout-plan-store.js', 'js/field/seam-layout-optimizer.js', 'js/field/layout-ui.js'].forEach(load);
}

module.exports = async function run() {
  const t = makeRunner('seam-layout-optimizer');
  const { G, data } = setupEnv();
  loadAll();
  const OPT = G.AAA_SEAM_LAYOUT_OPTIMIZER, E = G.AAA_LAYOUT_CONSTRAINT_ENGINE, GEN = G.AAA_CUT_LIST_GENERATOR;
  const STORE = G.AAA_LAYOUT_PLAN_STORE, UI = G.AAA_LAYOUT_UI;

  // ===== 12-foot roll is respected; nap is never rotated =====
  t.eq('roll width is fixed at 12 ft', E.ROLL_WIDTH_FT, 12);
  const box = E.boxRoom({ length: 15, width: 18 }, 'LENGTHWISE');
  t.ok('a 15×18 room creates a main drop + a fill (both > 12ft)', !!box.main && !!box.fill);
  t.ok('the main drop is capped at the 12-ft roll width', box.main.widthFt === 12);
  t.ok('with a known nap the orientation is fixed (no rotation): drop length = room length', box.main.lengthFt === 15 && box.fill.widthFt === 6);

  // a narrow room leaves a harvestable leftover, never a rotated fill
  const narrowBox = E.boxRoom({ length: 20, width: 4 }, 'LENGTHWISE');
  t.ok('a ≤12ft room is one drop with a leftover strip', narrowBox.fill === null && narrowBox.leftover && narrowBox.leftover.widthFt === 8);

  // ===== cut-list: 15×18 main+fill, hallway harvested from a compatible leftover =====
  const cl = GEN.generate([
    { roomName: 'Living', length: 18, width: 15 },   // needs a 3ft fill
    { roomName: 'Hall', length: 18, width: 2 }        // 2ft strip — harvestable from Living's leftover? leftover is 12-15<0... use below
  ], 'LENGTHWISE');
  t.ok('cut list produces a cut per room', cl.ok && cl.cuts.length === 2);

  // harvesting: a wide room + a narrow room whose drop yields a big leftover
  const harvest = GEN.generate([
    { roomName: 'Big', length: 18, width: 5 },   // drop 5×18 → leftover 7×18
    { roomName: 'Wide', length: 18, width: 16 }  // needs 4×18 fill → harvest from Big's 7×18 leftover
  ], 'LENGTHWISE');
  const wideCut = harvest.cuts.find(function (c) { return c.label === 'Wide'; });
  t.ok('a fill is harvested from a compatible leftover (nap preserved, not rotated)', wideCut.subCuts.some(function (s) { return s.kind === 'fill' && s.harvestedFromCutId && s.rotated === false; }));
  t.ok('harvested fill consumes no fresh roll', harvest.harvestedSquareFeet > 0);

  // ===== full optimize: waste %, review gating =====
  const plan = await OPT.optimize({ rooms: [{ roomName: 'Living', length: 18, width: 15 }], napDirection: 'LENGTHWISE', persist: false });
  t.ok('plan reports linear feet, square yards, and waste %', plan.totalLinearFeetOrdered > 0 && plan.totalSquareYards > 0 && plan.calculatedWastePercentage != null);
  t.ok('a quote-impacting plan is always review-gated', plan.needsReview === true);
  t.ok('roll width on the plan is 12', plan.rollWidthFt === 12);

  // ===== insufficient geometry =====
  const bare = await OPT.optimize({ rooms: [{ roomName: 'Mystery', squareFeet: 200 }], persist: false });
  t.eq('square-feet-only (no shape) is insufficient_data', bare.status, 'insufficient_data');
  t.ok('insufficient geometry needsReview', bare.needsReview === true && bare.totalLinearFeetOrdered === null);

  // ===== unknown nap → needsReview =====
  const unknownNap = await OPT.optimize({ rooms: [{ roomName: 'A', length: 10, width: 9 }, { roomName: 'B', length: 11, width: 8 }], persist: false });
  t.eq('multi-room with no chosen nap resolves UNKNOWN', unknownNap.globalNapDirection, 'UNKNOWN');
  t.ok('unknown nap forces review', unknownNap.needsReview === true);

  // ===== seam risk flags narrow fill strips =====
  const narrowFill = await OPT.optimize({ rooms: [{ roomName: 'OddWide', length: 20, width: 13 }], napDirection: 'LENGTHWISE', persist: false }); // 1ft fill → narrow
  t.ok('a narrow fill strip is flagged as a seam risk', JSON.stringify(narrowFill.cuts).indexOf('narrow_fill_strip') !== -1 || narrowFill.warnings.some(function (w) { return /[Nn]arrow/.test(w); }));
  t.ok('missing threshold data is always warned (seam placement unverifiable)', narrowFill.warnings.some(function (w) { return /doorway|traffic|light/i.test(w); }));

  // ===== append-only store; no quote mutation =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} });
  const p1 = await OPT.optimize({ sessionId: 'sess1', rooms: [{ roomName: 'R', length: 14, width: 10 }], napDirection: 'LENGTHWISE' });
  const p2 = await OPT.optimize({ sessionId: 'sess1', rooms: [{ roomName: 'R', length: 14, width: 10 }], napDirection: 'LENGTHWISE' });
  t.ok('each optimize run is a new append-only plan', p1.layoutPlanId !== p2.layoutPlanId && (await STORE.list({ sessionId: 'sess1' })).length === 2);
  t.ok('stored plans are immutable (frozen)', Object.isFrozen(await STORE.get(p1.layoutPlanId)));
  t.eq('the optimizer mutates no production quote/job', JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} }), prodBefore);

  // ===== UI render model + review badge =====
  const model = UI.renderModel(p1);
  t.ok('UI render model exposes cut list + material summary + warnings', Array.isArray(model.cutList) && model.materialSummary && Array.isArray(model.warnings));
  t.eq('review-gated plan shows the Estimator Review Required badge', model.reviewBadge, 'Estimator Review Required');
  t.ok('UI html renders safely', /ly-card/.test(UI.html(p1)));
  t.eq('UI mount is a no-op without a DOM', (await UI.mount()).mounted, false);

  return t.report();
};
