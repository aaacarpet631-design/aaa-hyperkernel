/*
 * AAA Copilot Telemetry — in-memory, PII-free observability for the remote
 * copilot path (mission Slice E hardening).
 *
 * record({job, outcome, error?, latencyMs?, budgetMs?}) keeps a bounded ring
 * of recent asks (flag 'copilotTelemetryRing', default 200) plus aggregate
 * counters that survive ring eviction. summary() answers the release-gate
 * questions: how often does the remote path succeed / fail / fall back, WHY
 * (error codes), for WHICH jobs, and what the latency looks like (nearest-
 * rank p50/p95 over the ring) against the budget (violation count).
 *
 * PII DISCIPLINE: only whitelisted fields are stored — job name, outcome,
 * error code, and two numbers. Message text, answers, customer data, or any
 * other field on the entry are dropped on the floor by construction.
 *
 * Zero-dep, deterministic given inputs, no storage, no network, no DOM.
 * reset() exists for tests. Never throws; garbage in → { ok:false } out.
 */
;(function (global) {
  'use strict';

  function flag(k, d) {
    const c = global.AAA_CONFIG;
    return c && typeof c.flag === 'function' ? c.flag(k, d) : d;
  }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  const OUTCOMES = ['remote_ok', 'remote_failed', 'local_fallback'];
  const DEFAULT_RING = 200;

  function ringCap() {
    const n = Number(flag('copilotTelemetryRing', DEFAULT_RING));
    return isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RING;
  }

  function freshCounts() {
    return { total: 0, byOutcome: {}, byError: {}, byJob: {}, budgetViolations: 0 };
  }

  let ring = [];
  let counts = freshCounts();

  function bump(map, key) { map[key] = (map[key] || 0) + 1; }
  function copyMap(map) {
    const out = {};
    Object.keys(map).forEach(function (k) { out[k] = map[k]; });
    return out;
  }
  // Nearest-rank percentile over an ascending-sorted array.
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
  }

  const Telemetry = {
    OUTCOMES: OUTCOMES.slice(),

    /**
     * entry: { job, outcome:'remote_ok'|'remote_failed'|'local_fallback',
     *          error?, latencyMs?, budgetMs? }
     * Whitelisted fields only — everything else (message text, payloads) is
     * discarded by construction. → { ok:true } or { ok:false, error }.
     */
    record(entry) {
      const e = entry || {};
      if (OUTCOMES.indexOf(e.outcome) === -1) return { ok: false, error: 'INVALID_OUTCOME' };
      const rec = {
        job: typeof e.job === 'string' && e.job ? e.job : 'unknown',
        outcome: e.outcome,
        error: typeof e.error === 'string' && e.error ? e.error : null,
        latencyMs: isFiniteNum(e.latencyMs) && e.latencyMs >= 0 ? e.latencyMs : null,
        budgetMs: isFiniteNum(e.budgetMs) && e.budgetMs > 0 ? e.budgetMs : null
      };
      counts.total += 1;
      bump(counts.byOutcome, rec.outcome);
      bump(counts.byJob, rec.job);
      if (rec.error) bump(counts.byError, rec.error);
      if (rec.latencyMs != null && rec.budgetMs != null && rec.latencyMs > rec.budgetMs) counts.budgetViolations += 1;
      ring.push(rec);
      const cap = ringCap();
      if (ring.length > cap) ring.splice(0, ring.length - cap);
      return { ok: true };
    },

    /**
     * → { total, byOutcome, byError, byJob, budgetViolations,
     *     latency: { count, p50, p95 } }.
     * Counts are lifetime aggregates; percentiles cover the retained ring.
     */
    summary() {
      const lat = ring
        .map(function (r) { return r.latencyMs; })
        .filter(function (v) { return v != null; })
        .sort(function (a, b) { return a - b; });
      return {
        total: counts.total,
        byOutcome: copyMap(counts.byOutcome),
        byError: copyMap(counts.byError),
        byJob: copyMap(counts.byJob),
        budgetViolations: counts.budgetViolations,
        latency: { count: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95) }
      };
    },

    /** Retained ring entries (copies) — codes and numbers only, never text. */
    entries() {
      return ring.map(function (r) {
        return { job: r.job, outcome: r.outcome, error: r.error, latencyMs: r.latencyMs, budgetMs: r.budgetMs };
      });
    },

    /** Drop the ring AND the aggregate counters (tests, workspace switch). */
    reset() {
      ring = [];
      counts = freshCounts();
    }
  };

  global.AAA_COPILOT_TELEMETRY = Telemetry;
})(typeof window !== 'undefined' ? window : this);
