/*
 * AAA Follow-up Intelligence — the right next touch for the buying stage.
 *
 * Combines the Silence Analyzer's stage with the Timing Engine's learned window
 * to produce a concrete follow-up sequence: what to send, through which intent
 * frame, and when. The cadence is stage-appropriate (a ghost gets a different
 * sequence than someone Evaluating). It composes existing engines — it does not
 * re-derive their data. Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function silence() { return global.AAA_SILENCE_ANALYZER; }
  function timing() { return global.AAA_TIMING_ENGINE; }

  // stage → ordered sequence of {channel, message, afterDays}
  const SEQUENCES = {
    Interested: [{ channel: 'sms', message: 'Quick check-in + offer to answer any questions', afterDays: 1 }, { channel: 'call', message: 'Walk through the estimate live', afterDays: 3 }],
    Evaluating: [{ channel: 'email', message: 'Send proof packet (reviews + before/after)', afterDays: 1 }, { channel: 'sms', message: 'Offer a no-pressure site visit', afterDays: 3 }],
    Comparing: [{ channel: 'call', message: 'Differentiate on guarantee + responsiveness vs alternatives', afterDays: 1 }, { channel: 'email', message: 'Itemized value breakdown', afterDays: 2 }],
    ReadyToBuy: [{ channel: 'call', message: 'Close: confirm scope, schedule the crew', afterDays: 0 }],
    Ghosted: [{ channel: 'sms', message: 'Soft re-engage: "still want this handled?" + easy yes', afterDays: 0 }, { channel: 'email', message: 'Final value reminder + expiry', afterDays: 4 }],
    Lost: []
  };

  const Engine = {
    /** @param record a lead/estimate → { stage, sequence, window, status }. */
    async sequence(record, now) {
      const stage = silence() ? silence().stageOf(record, now) : { stage: 'Interested', status: 'insufficient_data' };
      const seq = SEQUENCES[stage.stage] || [];
      let window = null;
      try { if (timing()) { const w = await timing().bestWindow(); if (w.status === 'derived') window = { bestHour: w.bestHour, bestDay: w.bestDay }; } } catch (_) {}
      return { stage: stage.stage, daysSilent: stage.daysSilent, sequence: seq, window: window, windowStatus: window ? 'derived' : 'insufficient_data', status: stage.status };
    }
  };

  global.AAA_FOLLOWUP_INTELLIGENCE = Engine;
})(typeof window !== 'undefined' ? window : this);
