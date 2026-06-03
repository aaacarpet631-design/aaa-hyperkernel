/*
 * Capture sequencer — guided auto-measure state machine.
 *
 * Drives the engine with a fake BLE controller (no Web Bluetooth): high-confidence
 * readings auto-advance, low-confidence readings HOLD until retake/accept, remote
 * triggers fire automatically when supported, and stale readings are never eaten.
 */
'use strict';
const { makeRunner } = require('../helpers/harness');

// Minimal stand-in for AAA_BLUETOOTH: subscribe/canMeasure/measure + a test
// _emit() that pushes a new reading through to subscribers.
function fakeBle(opts) {
  opts = opts || {};
  let canMeasure = opts.canMeasure !== false;
  let subs = [];
  let tick = 0;
  let measureCalls = 0;
  let state = { lastReading: null, lastReadingAt: null };
  return {
    getState: () => Object.assign({}, state),
    subscribe(cb) { subs.push(cb); cb(Object.assign({}, state)); return () => { subs = subs.filter((s) => s !== cb); }; },
    canMeasure: () => canMeasure,
    measure: async () => { measureCalls++; return { ok: true }; },
    setCanMeasure(v) { canMeasure = v; },
    _measureCalls: () => measureCalls,
    _emit(reading) {
      tick++;
      reading.__seq = tick;
      state = { lastReading: reading, lastReadingAt: 't' + tick };
      subs.forEach((cb) => { try { cb(Object.assign({}, state)); } catch (_) {} });
    }
  };
}

module.exports = function run() {
  const t = makeRunner('capture-sequencer');
  const G = global; G.window = G;
  delete require.cache[require.resolve('../../js/measurements/capture-sequencer.js')];
  require('../../js/measurements/capture-sequencer.js');
  const SEQ = G.AAA_CAPTURE_SEQUENCER;
  t.ok('module exposed', !!SEQ && typeof SEQ.create === 'function');

  // --- happy path: two confident readings auto-advance to complete ----------
  (function () {
    const ble = fakeBle();
    const updates = [];
    const seq = SEQ.create({ ble: ble, onUpdate: (s) => updates.push(s.event) });
    seq.start();
    t.eq('starts awaiting length', seq.getState().step.key, 'length');
    t.eq('auto-triggered remote shutter on start', ble._measureCalls(), 1);

    ble._emit({ feet: 10, confidence: 0.9 });
    let st = seq.getState();
    t.ok('length recorded', st.results.length && st.results.length.feet === 10);
    t.ok('not flagged as override', st.results.length.override === false);
    t.eq('advanced to width', st.step.key, 'width');
    t.eq('auto-triggered again for width', ble._measureCalls(), 2);

    ble._emit({ feet: 12, confidence: 0.92 });
    st = seq.getState();
    t.eq('status complete', st.status, 'complete');
    t.eq('square feet computed', st.squareFeet, 120);
    t.ok('emitted complete event', updates.indexOf('complete') !== -1);
  })();

  // --- low confidence HOLDS, does not record, then retake succeeds ----------
  (function () {
    const ble = fakeBle();
    const seq = SEQ.create({ ble: ble, minConfidence: 0.85 });
    seq.start();
    ble._emit({ feet: 9, confidence: 0.5 });
    let st = seq.getState();
    t.eq('held on low confidence', st.status, 'low-confidence');
    t.ok('pending reading surfaced', st.pending && st.pending.feet === 9);
    t.ok('nothing recorded yet', !st.results.length);

    seq.retake();
    ble._emit({ feet: 9.1, confidence: 0.95 });
    st = seq.getState();
    t.ok('retake then confident reading records', st.results.length && st.results.length.feet === 9.1);
    t.eq('advanced after retake', st.step.key, 'width');
  })();

  // --- explicit accept() of a low reading records an OVERRIDE ----------------
  (function () {
    const ble = fakeBle();
    const seq = SEQ.create({ ble: ble });
    seq.start();
    ble._emit({ feet: 8.4, confidence: 0.4 });
    t.eq('held', seq.getState().status, 'low-confidence');
    const r = seq.accept();
    t.ok('accept ok', r.ok === true);
    const st = seq.getState();
    t.ok('recorded with override flag', st.results.length && st.results.length.override === true);
    t.eq('accept advances', st.step.key, 'width');
  })();

  // --- no remote shutter: trigger() reports manual, readings still flow ------
  (function () {
    const ble = fakeBle({ canMeasure: false });
    const seq = SEQ.create({ ble: ble });
    seq.start();
    t.eq('no auto-trigger without remote shutter', ble._measureCalls(), 0);
    const r = seq.trigger();
    t.ok('trigger() reports manual', r && r.manual === true);
    ble._emit({ feet: 11, confidence: 0.9 });
    t.ok('manual reading still recorded', seq.getState().results.length.feet === 11);
  })();

  // --- stale reading present BEFORE start is not consumed --------------------
  (function () {
    const ble = fakeBle();
    ble._emit({ feet: 99, confidence: 0.99 }); // happened before we started
    const seq = SEQ.create({ ble: ble });
    seq.start();
    const st = seq.getState();
    t.eq('still awaiting (stale not eaten)', st.status, 'awaiting');
    t.ok('no stale result', !st.results.length);
  })();

  // --- angle/non-length reading is ignored ----------------------------------
  (function () {
    const ble = fakeBle();
    const seq = SEQ.create({ ble: ble });
    seq.start();
    ble._emit({ confidence: 0.95 }); // no feet -> not a length
    t.eq('non-length ignored', seq.getState().status, 'awaiting');
    t.ok('nothing recorded from angle frame', !seq.getState().results.length);
  })();

  // --- custom steps + skip ---------------------------------------------------
  (function () {
    const ble = fakeBle({ canMeasure: false });
    const seq = SEQ.create({ ble: ble, steps: [{ key: 'length', label: 'L' }, { key: 'width', label: 'W' }, { key: 'height', label: 'H' }] });
    seq.start();
    ble._emit({ feet: 10, confidence: 0.9 });
    ble._emit({ feet: 12, confidence: 0.9 });
    t.eq('on third custom step', seq.getState().step.key, 'height');
    seq.skip();
    t.eq('skip to complete', seq.getState().status, 'complete');
    t.ok('skipped step recorded null', seq.getState().results.height === null);
  })();

  // --- stop() unsubscribes: later readings are ignored ----------------------
  (function () {
    const ble = fakeBle();
    const seq = SEQ.create({ ble: ble });
    seq.start();
    seq.stop();
    ble._emit({ feet: 10, confidence: 0.9 });
    t.ok('no record after stop', !seq.getState().results.length);
  })();

  return t.report();
};
