/*
 * AAA Workforce Runner — the one function every runtime drives.
 *
 * runTick() is what a Netlify scheduled function, a server cron, a test, or
 * the app's manual tick button calls. It adds the property the scheduler
 * alone cannot give you: GLOBAL mutual exclusion. Two overlapping runners
 * (cron retry, redeploy overlap, a human clicking during a cron) resolve to
 * exactly one executing tick — the other is told TICK_LEASE_HELD and told
 * WHO holds it, never silently double-run.
 *
 * Layered exclusion, all persisted state:
 *   tick lease   'workforce.tick'  — one tick at a time per workspace
 *   agent lease  'agent:<id>'      — one execution per agent (scheduler)
 *   tick token   'sched@nextRunAt' — one JOB per due-mark (queue, idempotent)
 *
 * The kill switch is checked here too (defense in depth with the scheduler):
 * a server runner with a stale deploy still cannot run a disabled workforce.
 */
;(function (global) {
  'use strict';

  const TICK_LEASE = 'workforce.tick';
  const TICK_TTL_MS = 4 * 60e3; // < any sane cron period; a dead runner is taken over next tick

  function scheduler() { return global.AAA_WORKFORCE_SCHEDULER; }
  function lease() { return global.AAA_WORKFORCE_LEASE; }

  const Runner = {
    TICK_LEASE: TICK_LEASE,

    /**
     * One governed, mutually-exclusive tick.
     * opts: { owner (required for real runners), at, leaseTtlMs }
     */
    runTick: async function (opts) {
      const o = opts || {};
      const owner = o.owner || 'local';
      const s = scheduler();
      if (!s) return { ok: false, error: 'SCHEDULER_MISSING' };
      if (!s.enabled()) return { ok: true, ran: 0, skipped: 'CONTINUOUS_AGENTS_DISABLED', owner: owner };

      const lm = lease();
      if (lm) {
        const got = await lm.acquire(TICK_LEASE, { owner: owner, ttlMs: o.leaseTtlMs || TICK_TTL_MS });
        if (!got.ok) return { ok: true, ran: 0, skipped: 'TICK_LEASE_HELD', holder: got.holder, expiresAt: got.expiresAt, owner: owner };
      }
      try {
        const res = await s.runDue({ at: o.at, owner: owner });
        return Object.assign({ owner: owner }, res);
      } finally {
        if (lm) { try { await lm.release(TICK_LEASE, owner); } catch (_) { /* best-effort */ } }
      }
    },

    /** Event ingress for webhook-driven runners — same exclusions per agent/token. */
    runEvent: async function (type, payload, opts) {
      const o = opts || {};
      const s = scheduler();
      if (!s) return { ok: false, error: 'SCHEDULER_MISSING' };
      return s.onEvent(type, payload, { owner: o.owner || 'local' });
    }
  };

  global.AAA_WORKFORCE_RUNNER = Runner;
})(typeof window !== 'undefined' ? window : this);
