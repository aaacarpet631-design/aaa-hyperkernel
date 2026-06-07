/* HyperMind Core — the continuous loop driver: phases, gating, ledger, kill switch. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('hypermind-core');
  const { G, cfg, data } = setupEnv();
  load('js/intelligence/hypermind-core.js');
  const HM = G.AAA_HYPERMIND;
  HM._reset();

  // ===== default OFF: boot() must be a no-op (existing behaviour unchanged) =====
  t.ok('disabled by default', HM.enabled() === false);
  const booted = HM.boot();
  t.ok('boot() does not start the loop when disabled', booted.running === false);

  // ===== a tick runs all 9 phases even with NO intelligence modules present =====
  // (every phase should cleanly SKIP, never throw, never fabricate)
  const t0 = await HM.tick({ source: 'test' });
  t.eq('tick runs all nine phases', t0.phases.length, 9);
  t.ok('phase order is canonical', JSON.stringify(t0.phases.map((p) => p.phase)) === JSON.stringify(HM.PHASES));
  t.ok('all data-driven phases skip cleanly when modules absent', t0.counts.skipped >= 6 && t0.counts.error === 0);
  t.eq('status ok when nothing errored', t0.status, 'ok');
  t.ok('execute defers (advisory-only, no executor installed)', t0.phases.find((p) => p.phase === 'execute').status === 'skipped');
  t.ok('tick persisted to the ledger', (await data.list('hypermind_ticks')).length === 1);

  // ===== phases actually CALL the existing modules when present =====
  const calls = {};
  G.AAA_OUTCOME_INTELLIGENCE = {
    ingest: async () => { calls.ingest = true; return { ok: true, added: 5 }; },
    scoreAgents: async () => { calls.score = true; return { ok: true, scoreboard: [1, 2, 3] }; },
    extractPatterns: async () => { calls.patterns = true; return { ok: true, patterns: 4 }; }
  };
  G.AAA_GRAPH = { stats: async () => { calls.graph = true; return { nodeCount: 12, edgeCount: 20, byType: {} }; } };
  G.AAA_KNOWLEDGE = { index: async () => { calls.knowledge = true; return { ok: true, added: 3, total: 9 }; } };
  G.AAA_PREDICTION_CLOSURE = { evaluate: async () => { calls.evaluate = true; return { ok: true, evaluated: 3 }; }, close: async () => ({ ok: true, closed: 2 }) };
  G.AAA_PRICING_OPTIMIZER = { analyze: async () => { calls.plan = true; return { ok: true, recommendations: [{ id: 'r1' }, { id: 'r2' }] }; } };
  G.AAA_RELIABILITY = { snapshot: async () => { calls.snapshot = true; return { ok: true }; } };
  G.AAA_SIGNAL_INGEST = { ingest: async () => { calls.signals = true; return { ok: true, added: 4, bySource: { invoices: 4 } }; } };

  const t1 = await HM.tick({ source: 'test' });
  t.ok('OBSERVE called outcome-intelligence.ingest', calls.ingest === true);
  t.ok('OBSERVE called the wider signal ingest', calls.signals === true);
  t.ok('REMEMBER refreshed the graph', calls.graph === true);
  t.ok('REMEMBER indexed the knowledge fabric', calls.knowledge === true);
  t.ok('PREDICT evaluated closures', calls.evaluate === true);
  t.ok('PLAN produced recommendations', calls.plan === true);
  t.ok('MEASURE scored agents', calls.score === true);
  t.ok('LEARN extracted patterns', calls.patterns === true);
  t.ok('UPDATE snapshotted reliability', calls.snapshot === true);
  t.ok('observe summary captured outcome + signal ingest', t1.phases.find((p) => p.phase === 'observe').summary.outcomes.added === 5 && t1.phases.find((p) => p.phase === 'observe').summary.signals.added === 4);
  t.ok('plan summary compresses recommendations to a count', t1.phases.find((p) => p.phase === 'plan').summary.recommendations.recommendations === 2);

  // ===== a throwing module is contained as an 'error' phase, loop survives =====
  G.AAA_OUTCOME_INTELLIGENCE.ingest = async () => { throw new Error('boom'); };
  const t2 = await HM.tick({ source: 'test' });
  const obs = t2.phases.find((p) => p.phase === 'observe');
  t.eq('throwing phase recorded as error', obs.status, 'error');
  t.ok('error message captured', /boom/.test(obs.error));
  t.eq('tick degraded (not crashed) on phase error', t2.status, 'degraded');
  t.ok('other phases still ran after the error', t2.counts.ran >= 5);

  // ===== EXECUTE delegates to an installed governed executor (the HM-4 seam) =====
  let executed = null;
  G.AAA_HYPERMIND_EXECUTOR = { run: async (ctx) => { executed = ctx; return { ok: true, applied: 1 }; } };
  const t3 = await HM.tick({ source: 'exec_test' });
  const ex = t3.phases.find((p) => p.phase === 'execute');
  t.eq('execute ran via installed executor', ex.status, 'ran');
  t.ok('executor received the tick context', executed && executed.tickId && executed.source === 'exec_test');
  delete G.AAA_HYPERMIND_EXECUTOR;

  // ===== enable/disable + kill switch =====
  G.setInterval = (fn, ms) => ({ _fn: fn, _ms: ms, unref() {} });
  G.clearInterval = () => { calls.cleared = true; };
  t.ok('setEnabled(true) persists the flag', HM.setEnabled(true) === true && cfg._all().hypermindEnabled === true);
  t.ok('loop is running after enable', HM.running() === true);
  t.ok('start() is idempotent', HM.start().running === true);
  t.ok('setEnabled(false) stops the loop (kill switch)', HM.setEnabled(false) === false && HM.running() === false && calls.cleared === true);
  t.ok('boot() starts the loop when enabled', (cfg.set({ hypermindEnabled: true }), HM.boot().running === true));
  HM.stop();

  // ===== interval floor protects against a bad config =====
  cfg.set({ hypermindIntervalMs: 10 });
  t.ok('interval is floored to a safe minimum', HM.intervalMs() >= 15000);

  // ===== observability: history + metrics =====
  const hist = await HM.history(3);
  t.ok('history returns recent ticks newest-first', hist.length === 3 && hist[0].startedAt >= hist[2].startedAt);
  const metrics = await HM.metrics();
  t.ok('metrics aggregate per-phase status across ticks', metrics.ticks >= 4 && metrics.phases.observe && (metrics.phases.observe.ran + metrics.phases.observe.error) >= 1);

  return t.report();
};
