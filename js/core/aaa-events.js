/*
 * AAA Events — a tiny, synchronous-emit pub/sub bus used to decouple domain
 * events (job.created, estimate.added, job.closed, …) from the things that
 * react to them (the automation engine, analytics, etc.). Handler errors are
 * isolated so one bad listener can't break an emit.
 */
;(function (global) {
  'use strict';
  const listeners = {};

  function run(fn, payload, type) {
    try {
      const r = fn(payload, type);
      if (r && typeof r.then === 'function') r.catch((e) => console.error('AAA_EVENTS handler', type, e));
    } catch (e) {
      console.error('AAA_EVENTS handler', type, e);
    }
  }

  const bus = {
    on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return () => this.off(type, fn);
    },
    off(type, fn) {
      const a = listeners[type];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    emit(type, payload) {
      (listeners[type] || []).slice().forEach((fn) => run(fn, payload, type));
      (listeners['*'] || []).slice().forEach((fn) => run(fn, payload, type)); // wildcard
    }
  };

  global.AAA_EVENTS = bus;
})(typeof window !== 'undefined' ? window : this);
