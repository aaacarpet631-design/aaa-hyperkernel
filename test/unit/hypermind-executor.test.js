/* HyperMind Executor — governed autonomous apply: gateway AUTO_TUNE, calibration,
 * advisory fallback, simulate guard, rollback, audit ledger. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('hypermind-executor');
  const { G, cfg, data } = setupEnv();

  // Real gateway + real calibration registry; fakes for closure + agent registry.
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/calibration-registry.js');
  load('js/intelligence/hypermind-core.js');
  load('js/intelligence/hypermind-executor.js');
  const GW = G.AAA_RUNTIME_GATEWAY, HM = G.AAA_HYPERMIND, EX = G.AAA_HYPERMIND_EXECUTOR, CAL = G.AAA_CALIBRATION_REGISTRY;

  // captured tuning installs
  const tunings = {};
  G.AAA_AGENTS = { setTuning: (agent, tun) => { tunings[agent] = tun; }, get: () => null };
  // closure signals: pricing_optimizer well-validated; estimator contradicted
  G.AAA_PREDICTION_CLOSURE = {
    calibrationSummary: async () => ({ agents: [
      { agent: 'pricing_optimizer', validated: 8, contradicted: 1, validationRate: 0.89, closures: 9, suggestedConfidenceBias: 5, netConfidenceSignal: 35 },
      { agent: 'estimator', validated: 2, contradicted: 6, validationRate: 0.25, closures: 8, suggestedConfidenceBias: -8, netConfidenceSignal: -20 }
    ] }),
    closures: async () => [],
    close: async () => ({ ok: true })
  };
  // make simulate see no harm (no decisions => sample 0 => improvement null => allowed)

  // ===== GATEWAY: AUTO_TUNE is AI-blocked until the owner flips the flag =====
  const denied = await GW.run({ action: 'AUTO_TUNE', origin: 'ai', actor: 'hypermind', mutate: async () => 'should-not-run' });
  t.eq('AUTO_TUNE denied for AI when autonomy flag is OFF', denied.error, 'AI_NOT_PERMITTED');
  // money/customer actions remain absolutely AI-blocked even with the flag on
  cfg.set({ hypermindAutoApply: true });
  const stillBlocked = await GW.run({ action: 'FINALIZE_PRICE', origin: 'ai', actor: 'x', mutate: async () => 'nope' });
  t.eq('FINALIZE_PRICE stays hard-blocked for AI regardless of flags', stillBlocked.error, 'AI_NOT_PERMITTED');
  const allowed = await GW.run({ action: 'AUTO_TUNE', origin: 'ai', actor: 'hypermind', detail: { op: 'x' }, mutate: async () => 'ran' });
  t.ok('AUTO_TUNE allowed for AI once owner enables autonomy', allowed.ok === true && allowed.result === 'ran');
  const audit = await GW.recentAudit(5);
  t.ok('autonomous apply is audited origin:ai + autonomous:true', audit.some((a) => a.action === 'AUTO_TUNE' && a.origin === 'ai' && a.decision === 'allowed' && a.detail && a.detail.autonomous === true));

  // ===== ADVISORY mode (autonomy OFF): propose only, apply nothing =====
  cfg.set({ hypermindAutoApply: false });
  const adv = await EX.run({ tickId: 'tk1', source: 'test' });
  t.eq('advisory mode reported', adv.mode, 'advisory');
  t.ok('advisory proposes both agents', adv.proposed === 2 && adv.applied === 0);
  t.eq('nothing installed in advisory mode', Object.keys(tunings).length, 0);
  t.eq('proposals left pending', (await CAL.listProposals('pending')).length, 2);

  // ===== AUTONOMOUS mode: auto-generate AND auto-apply, no human gate =====
  cfg.set({ hypermindAutoApply: true });
  const autoRes = await EX.run({ tickId: 'tk2', source: 'test' });
  t.eq('autonomous mode reported', autoRes.mode, 'autonomous');
  t.ok('both proposals auto-applied with no human approval', autoRes.applied === 2 && autoRes.skipped === 0);
  t.ok('tunings actually installed into the agent registry', tunings.pricing_optimizer && tunings.estimator);
  t.eq('pricing_optimizer confidence bias applied', tunings.pricing_optimizer.confidenceBias, 5);
  const versions = await CAL.versions();
  t.ok('versioned + marked autonomous (append-only history)', versions.length === 2 && versions.every((v) => v.autonomous === true && v.active));
  t.eq('proposals now approved', (await CAL.listProposals('approved')).length, 2);

  // ===== idempotent: re-running re-proposes but applies nothing new =====
  const again = await EX.run({ tickId: 'tk3', source: 'test' });
  t.ok('re-run does not double-apply (already approved)', again.applied === 0);

  // ===== simulate guard: a harmful tuning is skipped, not applied =====
  G.AAA_PREDICTION_CLOSURE.calibrationSummary = async () => ({ agents: [{ agent: 'follow_up', validated: 1, contradicted: 5, validationRate: 0.17, closures: 6, suggestedConfidenceBias: 9, netConfidenceSignal: -10 }] });
  G.AAA_PREDICTION_CLOSURE.closures = async () => [
    { agent: 'follow_up', predictionId: 'd1', status: 'contradicted' },
    { agent: 'follow_up', predictionId: 'd2', status: 'validated' }
  ];
  // d1: contradicted @45 → currently a HIT (predicts not-validated); +9 → 54 flips to MISS.
  // d2: validated @80 → HIT before and after. Net: alignment drops (improvement < 0).
  await data.put('agent_decisions', 'd1', { id: 'd1', workspaceId: 'ws_test', agent: 'follow_up', confidence: 45 });
  await data.put('agent_decisions', 'd2', { id: 'd2', workspaceId: 'ws_test', agent: 'follow_up', confidence: 80 });
  const guarded = await EX.run({ tickId: 'tk4', source: 'test' });
  const fu = guarded.details.find((d) => d.agent === 'follow_up');
  t.ok('a tuning that would reduce alignment is skipped by the guard', fu && fu.action === 'skipped' && fu.reason === 'would_reduce_alignment');
  t.ok('no version installed for the skipped agent', !tunings.follow_up);

  // ===== rollback reverts an autonomous tuning =====
  const rb = await EX.rollback('pricing_optimizer');
  t.ok('rollback succeeds', rb && rb.ok !== false);
  t.eq('pricing_optimizer reverted to baseline (tuning cleared)', tunings.pricing_optimizer, null);

  // ===== audit ledger captures every run =====
  const hist = await EX.history();
  t.ok('action ledger records runs (advisory + autonomous + rollback)', hist.length >= 4 && hist.some((h) => h.mode === 'autonomous') && hist.some((h) => h.mode === 'rollback'));

  // ===== status surfaces autonomy state =====
  t.ok('HM.status reports autoApply', HM.status().autoApply === true);
  t.ok('setAutoApply(false) is the advisory kill switch', HM.setAutoApply(false) === false);

  return t.report();
};
