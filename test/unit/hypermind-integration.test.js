/*
 * HyperMind END-TO-END — the capstone (HM-6).
 *
 * Wires the REAL modules together (gateway, knowledge-graph, outcome-intelligence,
 * signal-ingest, calibration-registry, hypermind-core, hypermind-executor), seeds a
 * real business, turns on full autonomy, and drives the loop — asserting the whole
 * chain: signals ingested → graph built → calibration auto-applied (audited
 * autonomous) → action ledger populated → idempotent → kill switch → rollback.
 * Only the signal SOURCE (prediction-closure) and the tuning SINK (agent registry)
 * are faked; everything in between is the production code path.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('hypermind-integration');
  const { G, cfg, data } = setupEnv();

  // ---- real modules ----
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/knowledge-graph.js');
  load('js/intelligence/outcome-intelligence.js');
  load('js/intelligence/signal-ingest.js');
  load('js/intelligence/calibration-registry.js');
  load('js/intelligence/hypermind-core.js');
  load('js/intelligence/hypermind-executor.js');
  const HM = G.AAA_HYPERMIND, EX = G.AAA_HYPERMIND_EXECUTOR, CAL = G.AAA_CALIBRATION_REGISTRY;
  HM._reset();

  // ---- faked endpoints: closure (signal source) + agent registry (sink) ----
  const tunings = {};
  G.AAA_AGENTS = { setTuning: (a, tun) => { tunings[a] = tun; }, get: () => null };
  G.AAA_PREDICTION_CLOSURE = {
    calibrationSummary: async () => ({ agents: [{ agent: 'pricing_optimizer', validated: 8, contradicted: 1, validationRate: 0.89, closures: 9, suggestedConfidenceBias: 6, netConfidenceSignal: 35 }] }),
    closures: async () => [], evaluate: async () => ({ ok: true, evaluated: 0 }), close: async () => ({ ok: true, closed: 0 })
  };

  // ---- seed a real business ----
  await data.put('customers', 'c1', { id: 'c1', name: 'Acme Apts', source: 'referral', createdAt: '2026-01-01T00:00:00Z' });
  await data.put('crew_members', 't1', { id: 't1', name: 'Dana' });
  await data.put('jobs', 'j1', { id: 'j1', customerId: 'c1', customerName: 'Acme Apts', assigneeIds: ['t1'], estimates: [{ type: 'carpet', marginPct: 35 }] });
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'won', marginPct: 35, sentAt: '2026-01-02T00:00:00Z', resolvedAt: '2026-01-04T00:00:00Z', customerId: 'c1', jobId: 'j1' });
  await data.put('outcomes', 'o1', { id: 'o1', jobId: 'j1', result: 'won', finalAmount: 1200 });
  await data.put('invoices', 'i1', { id: 'i1', jobId: 'j1', customerId: 'c1', amount: 1200, status: 'paid', issuedAt: '2026-01-05T00:00:00Z' });
  await data.put('payments', 'p1', { id: 'p1', invoiceId: 'i1', amount: 1200, receivedAt: '2026-01-06T00:00:00Z' });
  await data.put('expenses', 'e1', { id: 'e1', jobId: 'j1', amount: 300, category: 'materials', incurredAt: '2026-01-03T00:00:00Z' });

  // ---- turn on full autonomy and drive one tick ----
  cfg.set({ hypermindEnabled: true, hypermindAutoApply: true });
  const tick1 = await HM.tick({ source: 'integration' });

  // 1) OBSERVE — both event streams populated by real ingest
  t.ok('signals were ingested from the real sources', (await data.list('signals')).length >= 4);
  t.ok('outcome events were ingested from real quotes', (await data.list('outcome_events')).length >= 1);

  // 2) REMEMBER — the real graph built with the new entity types
  const stats = await G.AAA_GRAPH.stats();
  t.ok('graph built with technician + invoice + product entities', stats.nodeCount > 0 && stats.byType.technician >= 1 && stats.byType.invoice >= 1);

  // 3) EXECUTE — the executor ran via the seam and auto-applied
  const execPhase = tick1.phases.find((p) => p.phase === 'execute');
  t.eq('Execute phase ran via the installed executor', execPhase.status, 'ran');
  t.ok('autonomous apply happened in the tick', execPhase.summary && execPhase.summary.mode === 'autonomous' && execPhase.summary.applied >= 1);

  // 4) calibration actually applied + installed into the registry
  const versions = await CAL.versions();
  t.ok('an autonomous calibration version is active', versions.some((v) => v.active && v.autonomous && v.agent === 'pricing_optimizer'));
  t.eq('the tuning was installed into the agent registry', tunings.pricing_optimizer && tunings.pricing_optimizer.confidenceBias, 6);

  // 5) audited as origin:ai + autonomous through the REAL gateway
  const audit = await data.list('audit_log');
  t.ok('autonomous apply was audited (AUTO_TUNE, origin ai, autonomous)', audit.some((a) => a.action === 'AUTO_TUNE' && a.origin === 'ai' && a.decision === 'allowed' && a.detail && a.detail.autonomous === true));

  // 6) the ledgers recorded the work
  t.ok('tick ledger populated', (await data.list('hypermind_ticks')).length === 1 && (tick1.status === 'ok' || tick1.status === 'degraded'));
  t.ok('action ledger populated', (await EX.history()).some((h) => h.mode === 'autonomous' && h.applied >= 1));

  // 7) idempotent — a second tick re-observes nothing new and re-applies nothing
  const sigBefore = (await data.list('signals')).length;
  const tick2 = await HM.tick({ source: 'integration' });
  t.eq('signals are idempotent across ticks', (await data.list('signals')).length, sigBefore);
  t.eq('no new calibration version on an unchanged proposal', (await CAL.versions()).length, versions.length);
  t.eq('second tick applied nothing new', tick2.phases.find((p) => p.phase === 'execute').summary.applied, 0);

  // 8) kill switch — drop to advisory; the next tick applies nothing
  HM.setAutoApply(false);
  // change the signal so there'd be something to apply if autonomy were on
  G.AAA_PREDICTION_CLOSURE.calibrationSummary = async () => ({ agents: [{ agent: 'estimator', validated: 7, contradicted: 1, validationRate: 0.88, closures: 8, suggestedConfidenceBias: 4, netConfidenceSignal: 30 }] });
  const tick3 = await HM.tick({ source: 'integration' });
  t.eq('advisory mode after kill switch', tick3.phases.find((p) => p.phase === 'execute').summary.mode, 'advisory');
  t.ok('nothing auto-applied in advisory mode', !tunings.estimator && (await CAL.listProposals('pending')).some((p) => p.agent === 'estimator'));

  // 9) rollback unwinds the autonomous tuning
  HM.setAutoApply(true);
  const rb = await EX.rollbackAll();
  t.ok('rollbackAll reverts', rb.ok === true && rb.reverted >= 1);
  t.eq('pricing_optimizer reverted to baseline', tunings.pricing_optimizer, null);

  HM.stop();
  return t.report();
};
