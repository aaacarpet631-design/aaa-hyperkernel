/*
 * AAA Runtime Clock
 *
 * Single source of truth for time across the HyperKernel. Engines use now()
 * for millisecond timestamps stored on records and nowISO() for the ISO 8601
 * timestamps attached to sync mutations. Centralising this keeps every module
 * agreeing on "now" and makes time-dependent behaviour testable.
 */
;(function (global) {
  'use strict';
  const clock = {
    /** Epoch milliseconds. Used for record timestamps and sorting. */
    now: function () {
      return Date.now();
    },
    /** ISO 8601 string. Used for mutation timestamps. */
    nowISO: function () {
      return new Date().toISOString();
    }
  };
  global.AAA_RUNTIME_CLOCK = clock;
})(typeof window !== 'undefined' ? window : this);
