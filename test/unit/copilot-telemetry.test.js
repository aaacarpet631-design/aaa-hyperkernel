/* Copilot Telemetry — PII-free observability for the remote copilot path.
 *
 * Guards: only whitelisted fields (job/outcome/error codes + numbers) are
 * ever retained — message text dies at the door; the ring is bounded by the
 * copilotTelemetryRing flag while aggregate counters survive eviction;
 * summary() reports per-outcome/error/job counts, nearest-rank p50/p95
 * latency over the ring, and budget-violation counts; garbage in →
 * { ok:false } out, never a throw. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-telemetry');
  const { cfg, G } = setupEnv({ fixedISO: '2026-07-09T16:00:00.000Z' });
  load('js/copilot/copilot-telemetry.js');
  const T = G.AAA_COPILOT_TELEMETRY;

  // ===== garbage in, honest refusal out =====
  T.reset();
  t.ok('null entry is rejected', T.record(null).ok === false);
  t.ok('unknown outcome is rejected', T.record({ job: 'followups', outcome: 'exploded' }).ok === false);
  t.ok('rejected entries count nothing', T.summary().total === 0 && T.entries().length === 0);

  // ===== counters per outcome / error / job =====
  t.ok('remote_ok records', T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: 120, budgetMs: 6000 }).ok === true);
  T.record({ job: 'followups', outcome: 'remote_failed', error: 'REMOTE_TIMEOUT', latencyMs: 6200, budgetMs: 6000 });
  T.record({ job: 'attention_today', outcome: 'remote_failed', error: 'NETWORK_ERROR', latencyMs: 40, budgetMs: 6000 });
  T.record({ outcome: 'local_fallback' }); // no job → 'unknown'; no numbers is fine
  const s1 = T.summary();
  t.ok('counts per outcome', s1.total === 4 && s1.byOutcome.remote_ok === 1 && s1.byOutcome.remote_failed === 2 && s1.byOutcome.local_fallback === 1);
  t.ok('counts per error code', s1.byError.REMOTE_TIMEOUT === 1 && s1.byError.NETWORK_ERROR === 1);
  t.ok('counts per job (missing job is unknown)', s1.byJob.followups === 2 && s1.byJob.attention_today === 1 && s1.byJob.unknown === 1);
  t.ok('budget violation counted when latency exceeds budget', s1.budgetViolations === 1);
  t.ok('entryless latencies are excluded from percentiles', s1.latency.count === 3);

  // ===== nearest-rank percentiles =====
  T.reset();
  for (let i = 1; i <= 10; i++) T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: i * 10, budgetMs: 60 });
  const s2 = T.summary();
  t.eq('p50 is the nearest-rank 5th of 10 sorted latencies', s2.latency.p50, 50);
  t.eq('p95 is the nearest-rank 10th of 10 sorted latencies', s2.latency.p95, 100);
  t.eq('violations = latencies over the 60ms budget', s2.budgetViolations, 4);

  // non-finite numbers are dropped, not stored and never a violation
  T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: Infinity, budgetMs: 10 });
  T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: 'fast', budgetMs: 10 });
  const s3 = T.summary();
  t.ok('non-finite latencies are dropped from stats', s3.latency.count === 10 && s3.budgetViolations === 4 && s3.total === 12);

  // ===== PII discipline: only whitelisted fields survive =====
  T.reset();
  T.record({ job: 'draft_followup', outcome: 'remote_ok', latencyMs: 5, budgetMs: 100,
    message: 'SECRET customer text', answer: 'SECRET reply', customer: { phone: '555-0100' } });
  const dumped = JSON.stringify(T.entries()) + JSON.stringify(T.summary());
  t.ok('message text and payloads never survive recording', dumped.indexOf('SECRET') === -1 && dumped.indexOf('555-0100') === -1);
  t.ok('whitelisted fields do survive', T.entries()[0].job === 'draft_followup' && T.entries()[0].latencyMs === 5);

  // ===== the ring is bounded by flag; aggregate counters are not =====
  cfg.set({ copilotTelemetryRing: 5 });
  T.reset();
  for (let i = 1; i <= 10; i++) T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: i, budgetMs: 100 });
  const s4 = T.summary();
  t.ok('ring keeps only the newest N entries', T.entries().length === 5 && T.entries()[0].latencyMs === 6 && T.entries()[4].latencyMs === 10);
  t.ok('aggregate counters survive ring eviction', s4.total === 10 && s4.byOutcome.remote_ok === 10);
  t.ok('percentiles cover the retained ring only', s4.latency.count === 5 && s4.latency.p50 === 8 && s4.latency.p95 === 10);
  cfg.set({ copilotTelemetryRing: 'garbage' });
  T.record({ job: 'followups', outcome: 'remote_ok', latencyMs: 11, budgetMs: 100 });
  t.ok('a garbage ring flag falls back to the default bound', T.entries().length === 6);
  cfg.set({ copilotTelemetryRing: 200 });

  // ===== determinism + reset =====
  t.ok('summary is deterministic given inputs', JSON.stringify(T.summary()) === JSON.stringify(T.summary()));
  T.reset();
  const s5 = T.summary();
  t.ok('reset clears ring and counters', s5.total === 0 && T.entries().length === 0 && s5.latency.p50 === null && s5.budgetViolations === 0);

  return t.report();
};
