/* Room Scan Engine — polygon normalization, area/perimeter, attach to the
 * shared capture session, manual/laser fallback preserved, scan/laser conflict
 * detection, low-confidence + moisture → needsReview, explicit review-layout
 * only, no quote mutation, mock provider, honest unavailable for real hardware. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/measurements/models/measurement-models.js', 'js/measurements/storage/measurement-store.js',
   'js/quotes/integrations/measurement-to-quote.js', 'js/measurements/field-brain.js', 'js/measurements/field-capture-session.js',
   'js/field/layout-constraint-engine.js', 'js/field/cut-list-generator.js', 'js/field/layout-risk-analyzer.js', 'js/field/layout-plan-store.js', 'js/field/seam-layout-optimizer.js',
   'js/field/scan-normalizer.js', 'js/field/scan-anomaly-flags.js', 'js/field/scan-confidence-engine.js', 'js/field/room-polygon-store.js', 'js/field/room-scan-engine.js', 'js/field/scan-to-capture-adapter.js', 'js/field/room-scan-ui.js'].forEach(load);
}

module.exports = async function run() {
  const t = makeRunner('room-scan-engine');
  const { G, data } = setupEnv();
  loadAll();
  const N = G.AAA_SCAN_NORMALIZER, ENG = G.AAA_ROOM_SCAN_ENGINE, ADP = G.AAA_SCAN_TO_CAPTURE_ADAPTER;
  const FCS = G.AAA_FIELD_CAPTURE_SESSION, STORE = G.AAA_ROOM_POLYGON_STORE, UI = G.AAA_ROOM_SCAN_UI;

  // ===== polygon normalization, area, perimeter (metric → feet) =====
  // 4.572m × 5.4864m rectangle = 15ft × 18ft.
  const metric = [{ x: 0, y: 0 }, { x: 4.572, y: 0 }, { x: 4.572, y: 5.4864 }, { x: 0, y: 5.4864 }];
  const norm = N.normalize(metric, 'm');
  t.ok('points normalize from meters to feet', norm.status === 'normalized' && Math.abs(norm.bbox.lengthFt - 18) < 0.05 && Math.abs(norm.bbox.widthFt - 15) < 0.05);
  t.ok('area is computed (shoelace) ≈ 270 ft²', Math.abs(norm.areaSqFt - 270) < 1);
  t.ok('perimeter is computed ≈ 66 ft', Math.abs(norm.perimeterFt - 66) < 1);
  t.eq('fewer than 3 points is insufficient_data', N.normalize([{ x: 0, y: 0 }], 'ft').status, 'insufficient_data');

  // ===== mock provider works; real hardware sources are honest about availability =====
  const cap = await ENG.capture({ source: 'mock_scan', dims: { length: 18, width: 15 } });
  t.ok('mock provider captures a polygon', cap.status === 'captured' && cap.polygon.areaSqFt > 0 && cap.polygon.source === 'mock_scan');
  t.eq('an unimplemented hardware source with no points is unavailable (no fake)', (await ENG.capture({ source: 'lidar_scan' })).status, 'unavailable');
  t.ok('a real source still works when caller supplies points', (await ENG.capture({ source: 'roomplan_import', points: metric, units: 'm' })).status === 'captured');

  // ===== attach to the SAME capture session (one estimating path) =====
  const sess = await FCS.start({});
  const attach = await ADP.attach(sess.id, cap.polygon);
  t.ok('attaching creates a room from the polygon bbox', attach.ok && attach.created === true && attach.roomId);
  t.ok('the polygon overlay is stored (append-only)', (await STORE.list({ sessionId: sess.id })).length === 1);
  const room = (await FCS.rooms(sess.id))[0];
  t.ok('the created room carries the scanned dimensions', Math.abs(room.length - 18) < 0.05 && Math.abs(room.width - 15) < 0.05);
  t.ok('scan provenance is the polygon overlay linked to the room', (await ADP.polygonForRoom(sess.id, attach.roomId)) !== null);

  // ===== scan vs laser/manual conflict: preserve both, never overwrite =====
  const laserRoom = await FCS.addRoom(sess.id, { roomName: 'Den', length: 12, width: 10, source: 'bluetooth' });
  const conflictPoly = (await ENG.capture({ source: 'mock_scan', dims: { length: 16, width: 11 }, roomName: 'Den' })).polygon; // disagrees with 12×10
  const conflictAttach = await ADP.attach(sess.id, conflictPoly, { roomId: laserRoom.room.id });
  t.ok('a scan that disagrees with the laser flags a conflict', !!conflictAttach.conflict && conflictAttach.conflict.kind === 'scan_vs_measured');
  t.ok('both measurements are preserved (laser dims untouched)', conflictAttach.preservedMeasurement.length === 12 && (await FCS.rooms(sess.id)).filter(function (r) { return r.id === laserRoom.room.id; })[0].length === 12);
  t.ok('a conflict forces needsReview', conflictAttach.needsReview === true);

  // ===== low confidence → needsReview =====
  const lowConf = await ENG.capture({ source: 'mock_scan', dims: { length: 10, width: 9 }, deviceConfidence: 0.2 });
  t.ok('a low-confidence scan is marked needsReview', lowConf.polygon.confidence < 0.7 && lowConf.polygon.needsReview === true);

  // ===== moisture (and the anomaly stack) → waiver + needsReview, labor modifier recorded =====
  const moist = await ENG.capture({ source: 'mock_scan', dims: { length: 12, width: 15 }, anomalies: [{ type: 'moisture_intrusion', severity: 'high', affectedArea: 'entry_hall', estimatedSqFt: 72 }] });
  t.ok('a high moisture flag forces review + waiver', moist.polygon.needsReview === true && moist.polygon.waiverRequired === true);
  t.ok('moisture records a labor modifier for the Installation Twin (not applied to a price here)', moist.polygon.laborModifier > 1 && moist.polygon.anomalies[0].recommendedAction === 'inspect_subfloor');
  t.ok('the anomaly catalog leads with moisture + covers the field-veteran ten', G.AAA_SCAN_ANOMALY_FLAGS.TYPES[0] === 'moisture_intrusion' && G.AAA_SCAN_ANOMALY_FLAGS.TYPES.length >= 10);

  // ===== explicit Review Layout only (optimizer not auto-run on scan) =====
  const before = JSON.stringify({ layout_plans: data._store.layout_plans || {}, quotes: data._store.quotes || {} });
  t.ok('capturing/attaching does NOT create a layout plan', JSON.stringify({ layout_plans: data._store.layout_plans || {} }) === JSON.stringify({ layout_plans: before && (data._store.layout_plans || {}) }) && (data._store.layout_plans === undefined || Object.keys(data._store.layout_plans).length === 0));
  const review = await UI.reviewLayout(sess.id, { napDirection: 'LENGTHWISE' });
  t.ok('explicit Review Layout runs the optimizer (review-gated)', review.ok === true && review.plan.needsReview === true);

  // ===== no production quote mutation =====
  t.eq('the scan flow mutates no production quote', JSON.stringify(data._store.quotes || {}), JSON.stringify({}));

  // ===== UI render model =====
  const model = UI.renderModel(moist.polygon);
  t.ok('UI exposes area/perimeter/confidence/conflict/moisture/review', model.area && model.confidence && 'conflict' in model && model.moistureWarning && model.needsReview === true);
  t.eq('UI mount is a no-op without a DOM', (await UI.mount()).mounted, false);

  return t.report();
};
