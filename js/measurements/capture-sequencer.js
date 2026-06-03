/*
 * AAA Capture Sequencer — guided, hands-light room measurement automation.
 *
 * Instead of the tech arming each field by hand and tapping after every laser
 * pull, the sequencer walks a room's measurements in order (length → width → …),
 * fires the remote shutter when the device supports one (Huepar), and
 * AUTO-ADVANCES to the next step as soon as a confident reading lands. It is the
 * automation layer on top of the BLE controller's measure()/confidence work.
 *
 * It is deliberately a small, pure state machine with an INJECTED controller
 * (anything exposing subscribe/canMeasure/measure + state.lastReading/At), so it
 * runs headless in tests with no Web Bluetooth. It never throws into the UI.
 *
 * Guardrail (matches the quote engine's "no low-confidence into the total"
 * rule): a reading at or above minConfidence auto-accepts; below it the
 * sequencer HOLDS on the step with the reading marked pending, so the tech must
 * retake or explicitly accept it (which records an override flag). Automation
 * speeds the happy path; it never silently launders a bad measurement.
 */
;(function (global) {
  'use strict';

  const DEFAULT_STEPS = [
    { key: 'length', label: 'Length' },
    { key: 'width', label: 'Width' }
  ];
  const DEFAULT_MIN_CONFIDENCE = 0.85; // same threshold the plan/quote core use

  let _emitSeq = 0; // monotonic tag so identical timestamps still read as "new"

  function create(opts) {
    opts = opts || {};
    const ble = opts.ble;
    const steps = (Array.isArray(opts.steps) && opts.steps.length) ? opts.steps.slice() : DEFAULT_STEPS.slice();
    const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
    const autoTrigger = opts.autoTrigger !== false; // fire the remote shutter automatically when possible
    const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : function () {};

    let status = 'idle';   // idle | awaiting | low-confidence | complete
    let index = 0;
    const results = {};    // key -> { feet, confidence, override }
    let pending = null;    // { feet, confidence } held below threshold
    let lastEvent = null;  // 'started' | 'triggered' | 'accepted' | 'low-confidence' | 'complete' | 'skipped'
    let unsub = null;
    let lastSeenTag = null;

    function currentStep() { return steps[index] || null; }

    function readingTag(s) {
      // The controller carries lastReadingAt (ISO/string). Pair it with our own
      // monotonic counter so two readings with the same clock value still differ.
      if (!s || s.lastReading == null) return null;
      return String(s.lastReadingAt) + '#' + (s.lastReading.__seq != null ? s.lastReading.__seq : '');
    }

    function squareFeet() {
      const l = results.length && results.length.feet;
      const w = results.width && results.width.feet;
      if (typeof l === 'number' && typeof w === 'number') return Math.round(l * w * 100) / 100;
      return null;
    }

    function snapshot() {
      return {
        status: status,
        event: lastEvent,
        index: index,
        total: steps.length,
        step: currentStep(),
        steps: steps.slice(),
        results: JSON.parse(JSON.stringify(results)),
        pending: pending ? Object.assign({}, pending) : null,
        squareFeet: squareFeet(),
        canRemoteTrigger: !!(ble && ble.canMeasure && ble.canMeasure())
      };
    }

    function emit(event) { lastEvent = event; try { onUpdate(snapshot()); } catch (_) {} }

    function onState(s) {
      if (status !== 'awaiting' && status !== 'low-confidence') return;
      const tag = readingTag(s);
      if (tag == null || tag === lastSeenTag) return; // no NEW reading since last look
      lastSeenTag = tag;
      handleReading(s.lastReading);
    }

    function handleReading(r) {
      const feet = r && typeof r.feet === 'number' ? r.feet : null;
      if (feet == null) return; // not a length reading (e.g. angle frame) — ignore
      const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
      if (confidence >= minConfidence) {
        accept(feet, confidence, false);
      } else {
        pending = { feet: feet, confidence: confidence };
        status = 'low-confidence';
        emit('low-confidence');
      }
    }

    function accept(feet, confidence, override) {
      const step = currentStep();
      if (!step) return;
      results[step.key] = { feet: feet, confidence: confidence, override: !!override };
      pending = null;
      index += 1;
      if (index >= steps.length) {
        status = 'complete';
        emit('complete');
        return;
      }
      status = 'awaiting';
      emit('accepted');
      maybeAutoTrigger();
    }

    function maybeAutoTrigger() {
      if (autoTrigger && ble && ble.canMeasure && ble.canMeasure()) {
        // Fire and forget; the reading returns via the subscription.
        try { Promise.resolve(ble.measure()).catch(function () {}); } catch (_) {}
      }
    }

    return {
      /** Begin the sequence at step 0, subscribing to the controller. */
      start: function () {
        index = 0;
        for (const k in results) if (Object.prototype.hasOwnProperty.call(results, k)) delete results[k];
        pending = null;
        status = 'awaiting';
        // Baseline the current reading so we don't consume a stale one.
        lastSeenTag = ble && ble.getState ? readingTag(ble.getState()) : null;
        if (ble && ble.subscribe && !unsub) unsub = ble.subscribe(onState);
        emit('started');
        maybeAutoTrigger();
        return this;
      },

      /** Manually request a reading for the current step. */
      trigger: function () {
        if (status === 'complete') return { ok: false, error: 'DONE' };
        if (ble && ble.canMeasure && ble.canMeasure()) {
          emit('triggered');
          try { return ble.measure(); } catch (e) { return { ok: false, error: 'MEASURE_THREW', message: String(e) }; }
        }
        // No remote shutter: the tech pulls the trigger on the laser itself.
        emit('triggered');
        return { ok: true, manual: true, message: 'Pull the trigger on the laser to capture this step.' };
      },

      /** Accept the held low-confidence reading anyway (records an override). */
      accept: function () {
        if (status !== 'low-confidence' || !pending) return { ok: false, error: 'NOTHING_PENDING' };
        accept(pending.feet, pending.confidence, true);
        return { ok: true };
      },

      /** Discard the pending reading and re-measure the current step. */
      retake: function () {
        pending = null;
        status = 'awaiting';
        emit('accepted'); // status refresh; not a new value
        maybeAutoTrigger();
        return { ok: true };
      },

      /** Skip the current step (records no value) and advance. */
      skip: function () {
        const step = currentStep();
        if (!step) return { ok: false, error: 'DONE' };
        results[step.key] = null;
        pending = null;
        index += 1;
        if (index >= steps.length) { status = 'complete'; emit('complete'); }
        else { status = 'awaiting'; emit('skipped'); maybeAutoTrigger(); }
        return { ok: true };
      },

      getState: snapshot,

      /** Tear down the subscription. */
      stop: function () { if (unsub) { try { unsub(); } catch (_) {} unsub = null; } status = (status === 'complete' ? 'complete' : 'idle'); return this; }
    };
  }

  global.AAA_CAPTURE_SEQUENCER = {
    create: create,
    DEFAULT_STEPS: DEFAULT_STEPS,
    DEFAULT_MIN_CONFIDENCE: DEFAULT_MIN_CONFIDENCE,
    // Test helper: tag a reading so identical timestamps still read as distinct.
    tagReading: function (r) { r.__seq = ++_emitSeq; return r; }
  };
})(typeof window !== 'undefined' ? window : this);
