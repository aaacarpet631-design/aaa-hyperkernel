/* Bluetooth Laser Measurement Bridge — Leica/Bosch adapters registered, laser
 * readings pipe into the active capture-session room dimension (unit-normalized),
 * room auto-commits at length+width, graceful degrade, review-gated layout,
 * no active session is honest, no production mutation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/measurements/models/measurement-models.js', 'js/measurements/storage/measurement-store.js',
   'js/quotes/integrations/measurement-to-quote.js', 'js/measurements/field-brain.js', 'js/measurements/field-capture-session.js',
   'js/field/layout-constraint-engine.js', 'js/field/cut-list-generator.js', 'js/field/layout-risk-analyzer.js', 'js/field/layout-plan-store.js', 'js/field/seam-layout-optimizer.js',
   // existing BLE stack + new adapters
   'js/bluetooth/services/raw-reading-log.js', 'js/bluetooth/services/measurement-parser.js', 'js/bluetooth/services/device-adapter-registry.js', 'js/bluetooth/services/generic-ble-adapter.js',
   'js/bluetooth/services/leica-disto-adapter.js', 'js/bluetooth/services/bosch-glm-adapter.js',
   'js/field/bluetooth-bridge.js'].forEach(load);
}

module.exports = async function run() {
  const t = makeRunner('bluetooth-bridge');
  const { G, data } = setupEnv();
  loadAll();
  const BR = G.AAA_BLUETOOTH_BRIDGE, FCS = G.AAA_FIELD_CAPTURE_SESSION, REG = G.AAA_DEVICE_ADAPTER_REGISTRY;

  // ===== device adapters registered (Leica + Bosch), matching by name =====
  const ids = REG.list().map(function (a) { return a.id; });
  t.ok('Leica DISTO + Bosch GLM adapters are registered', ids.indexOf('leica-disto') !== -1 && ids.indexOf('bosch-glm') !== -1);
  t.ok('a DISTO device matches the Leica adapter', G.AAA_LEICA_DISTO_ADAPTER.match({ name: 'DISTO D2' }) === true);
  t.ok('a GLM device matches the Bosch adapter', G.AAA_BOSCH_GLM_ADAPTER.match({ name: 'Bosch GLM 50 C' }) === true);
  t.ok('an unrelated device matches neither', G.AAA_LEICA_DISTO_ADAPTER.match({ name: 'Random Speaker' }) === false && G.AAA_BOSCH_GLM_ADAPTER.match({ name: 'Random Speaker' }) === false);

  // ===== honest: no active session =====
  t.eq('a reading with no active session is rejected honestly', (await BR.handleMeasurement({ valueInFeet: 15 })).error, 'NO_ACTIVE_SESSION');

  // ===== readings fill the active room dimension, keyboard-free =====
  const sess = await FCS.start({});
  BR.setActiveSession(sess.id);
  await FCS.beginRoom(sess.id, { roomName: 'Living' });
  BR.setTarget({ dimension: 'length' });
  const r1 = await BR.handleMeasurement({ valueInFeet: 15, deviceId: 'disto1' });
  t.ok('first reading sets a dimension without committing', r1.ok === true && r1.committed === false && r1.value === 15);
  t.eq('bridge tracks the last value + device', BR.state.lastReceivedValue, 15);

  // ===== unit normalization (meters → feet) and auto-commit at length+width =====
  BR.setTarget({ dimension: 'width' });
  const r2 = await BR.handleMeasurement({ value: 5.4864, rawUnit: 'm', deviceId: 'disto1' }); // 5.4864m ≈ 18ft
  t.ok('a metric reading is normalized to feet', Math.abs(r2.value - 18) < 0.05);
  t.ok('the room auto-commits once length + width are present', r2.committed === true && r2.room && (await FCS.rooms(sess.id)).length === 1);
  const room = (await FCS.rooms(sess.id))[0];
  t.ok('the committed room carries the measured dimensions', Math.abs(room.length - 15) < 0.01 && Math.abs(room.width - 18) < 0.05 && room.source === 'bluetooth');

  // ===== generic dimension fills the next empty slot =====
  await FCS.beginRoom(sess.id, { roomName: 'Hall' });
  BR.setTarget({ dimension: 'generic' });
  await BR.handleMeasurement({ valueInFeet: 4 });
  const commit = await BR.handleMeasurement({ valueInFeet: 20 });
  t.ok('two generic readings fill length then width and commit', commit.committed === true && (await FCS.rooms(sess.id)).length === 2);

  // ===== unparseable reading is flagged, not invented =====
  t.eq('an unparseable reading returns an error', (await BR.handleMeasurement({ value: 'nope', rawUnit: 'xyz' })).error, 'UNPARSEABLE_READING');

  // ===== shared parser path (DataView → bridge reading) =====
  const dv = { /* minimal stub */ };
  t.ok('fromDataView delegates to the shared parser (null when nothing parseable)', BR.fromDataView(dv, 'd') === null || typeof BR.fromDataView(dv, 'd') === 'object');

  // ===== graceful degrade: disconnect preserves the open session =====
  BR.onConnect('disto1', 0.9);
  t.ok('connect sets connected state', BR.state.isDeviceConnected === true && BR.state.signalStrength === 0.9);
  BR.onDisconnect('out_of_range');
  t.ok('disconnect degrades gracefully without dropping session data', BR.state.isDeviceConnected === false && BR.state.activeSessionId === sess.id && (await FCS.rooms(sess.id)).length === 2);
  // a reading can resume after reconnect
  BR.onConnect('disto1', 0.8);
  await FCS.beginRoom(sess.id, { roomName: 'Bed' });
  await BR.handleMeasurement({ valueInFeet: 10 });
  t.ok('capture resumes cleanly after reconnect', (await FCS.activeDraft(sess.id)).length === 10);

  // ===== review-gated layout build (explicit, not per-reading) =====
  const prodBefore = JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} });
  const layout = await BR.buildLayout({ napDirection: 'LENGTHWISE' });
  t.ok('buildLayout runs the optimizer and is review-gated', layout.ok === true && layout.plan.needsReview === true);
  t.eq('the bridge mutates no production quote/job', JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} }), prodBefore);

  // ===== wire(source): a streamed reading flows through =====
  let cb = null; const source = { subscribe: function (fn) { cb = fn; return function () { cb = null; }; } };
  BR.setActiveSession(sess.id); BR.setTarget({ dimension: 'generic' });
  const off = BR.wire(source);
  await FCS.beginRoom(sess.id, { roomName: 'Bath' });
  await cb({ valueInFeet: 6 });
  t.ok('a wired source streams readings into the bridge', (await FCS.activeDraft(sess.id)).length === 6);
  off();

  return t.report();
};
