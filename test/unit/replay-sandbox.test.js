/* Replay Sandbox — determinism, zero production writes, version selection, KPI diff, provenance link, access. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('replay-sandbox');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/intelligence/calibration-registry.js');
  load('js/intelligence/replay-sandbox.js');
  const S = G.AAA_REPLAY_SANDBOX;
  const STORE = G.AAA_PROVENANCE;
  const GOV = G.AAA_GOVERNANCE;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // --- pureReplay is a deterministic, pure function ---
  const input = {
    subjectType: 'pricing_recommendation',
    base: { confidence: 60, risk: 35, marginPct: 20, price: 500 },
    inForce: { calibration: { confidenceBias: 0, riskBias: 0 }, policy: { marginFloor: 25, followUpDays: 3, reviewSlaHours: 48 } },
    chosen: { calibration: { confidenceBias: 10, riskBias: -5 }, policy: { marginFloor: 20, followUpDays: 1, reviewSlaHours: 24 } }
  };
  const r1 = S.pureReplay(input);
  const r2 = S.pureReplay(input);
  t.ok('pureReplay is deterministic', JSON.stringify(r1) === JSON.stringify(r2));
  t.eq('confidence moves by the calibration bias difference', r1.replayed.confidence, 70);
  t.eq('risk moves by the calibration risk-bias difference', r1.replayed.risk, 30);
  const kp = (k) => r1.kpis.find((x) => x.key === k);
  t.ok('price KPI never changes (rule 2)', kp('price').delta === 0 || kp('price').delta === null ? kp('price').changed === false : false);
  t.ok('margin floor KPI reflects the chosen policy', kp('margin').original === 25 && kp('margin').replayed === 20 && kp('margin').changed === true);
  t.ok('follow-up SLA KPI reflects the chosen policy', kp('followUp').original === 3 && kp('followUp').replayed === 1);
  t.ok('review SLA KPI reflects the chosen policy', kp('review').original === 48 && kp('review').replayed === 24);
  t.ok('booking likelihood tracks confidence', kp('booking').original === 60 && kp('booking').replayed === 70);
  t.ok('all six required KPI dimensions are present', ['price', 'margin', 'risk', 'followUp', 'review', 'booking'].every((k) => !!kp(k)));

  // --- council decision replay under a split-threshold policy ---
  const council = S.pureReplay({
    subjectType: 'council_session',
    base: { confidence: 80, decision: 'approve', disagreement: 50, tally: { approve: 3, revise: 1, reject: 1 } },
    inForce: { calibration: {}, policy: { splitThreshold: 60 } },   // 50 < 60 → stays approve
    chosen: { calibration: {}, policy: { splitThreshold: 40 } }     // 50 >= 40 → downgrades to revise
  });
  t.eq('original council decision holds at a high threshold', council.original.decision, 'approve');
  t.eq('chosen lower threshold downgrades approve → revise', council.replayed.decision, 'revise');
  t.ok('council decision KPI marks the change', council.kpis.find((k) => k.key === 'decision').changed === true);

  // --- set up real data: a provenance trace + calibration versions ---
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 20 });
  const trace = await STORE.record({
    subjectType: 'pricing_recommendation', subjectId: 'rec_pb', subjectLabel: 'Low win rate band', agent: 'pricing_optimizer',
    sourceQuotes: [{ quoteId: 'q1', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 20, resolved: true }],
    calibrationVersion: { id: 'calv_inforce', agent: 'pricing_optimizer', version: 1, confidenceBias: 0, riskBias: 0 },
    summary: { decision: 'Review pricing', confidence: 60, risk: 35 }, promptVersion: null, modelVersion: 'deterministic'
  });
  // a historical calibration version to swap in (via the calibration registry)
  await data.put('calibration_versions', 'calv_hot', { id: 'calv_hot', workspaceId: 'ws_test', agent: 'pricing_optimizer', version: 2, confidenceBias: 15, riskBias: -10, active: false });
  // a governed policy version to swap in
  const pol = await GOV.createDraft('policy', 'sales_sla', { marginFloor: 18, followUpDays: 1, reviewSlaHours: 24 }, { actor: 'owner' });
  await GOV.propose(pol.version.id, { actor: 'owner' }); await GOV.approve(pol.version.id, { actor: 'owner' }); await GOV.activate(pol.version.id, { actor: 'owner' });

  // The audit trail legitimately gains an entry on every gateway call; "zero
  // production writes" means no BUSINESS record changes — snapshot everything
  // except the append-only audit_log.
  const businessSnapshot = () => { const c = Object.assign({}, data._store); delete c.audit_log; return JSON.stringify(c); };

  // --- end-to-end replay: version selection + KPI diff + provenance link ---
  const snapshotBefore = businessSnapshot();
  const res = await S.replay({
    traceId: trace.id, actor: 'owner',
    scenario: { calibrationVersionId: 'calv_hot', policyVersionId: pol.version.id }
  });
  t.ok('replay succeeds + anchors the trace', res.ok === true && res.trace.id === trace.id && res.trace.subjectId === 'rec_pb');
  t.ok('selected calibration version is resolved', res.scenario.calibration.id === 'calv_hot' && res.scenario.calibration.confidenceBias === 15);
  t.eq('replayed confidence reflects the chosen calibration', res.replayed.confidence, 75); // 60 + (15 - 0)
  t.eq('replayed risk reflects the chosen calibration', res.replayed.risk, 25);           // 35 + (-10 - 0)
  t.ok('KPI diff shows the policy follow-up change', res.kpis.find((k) => k.key === 'followUp').replayed === 1);
  t.ok('links back to provenance + governance + calibration', res.links.provenanceTraceId === trace.id && res.links.governanceVersionIds.indexOf(pol.version.id) !== -1 && res.links.calibrationVersionIds.indexOf('calv_hot') !== -1);
  t.eq('reported writes is zero', res.writes, 0);

  // --- ZERO production writes: every business collection is byte-identical ---
  t.eq('replay mutates NO business record (no persist)', businessSnapshot(), snapshotBefore);

  // --- determinism end-to-end: same scenario → identical comparison ---
  const res2 = await S.replay({ traceId: trace.id, actor: 'owner', scenario: { calibrationVersionId: 'calv_hot', policyVersionId: pol.version.id } });
  t.ok('two identical replays produce identical KPIs/result', JSON.stringify(res.kpis) === JSON.stringify(res2.kpis) && JSON.stringify(res.replayed) === JSON.stringify(res2.replayed));

  // --- optional persistence writes ONLY an owner-only snapshot, no business record ---
  const bizBefore = JSON.stringify({ quotes: data._store.quotes, calibration_versions: data._store.calibration_versions, pricing_recommendations: data._store.pricing_recommendations, agent_decisions: data._store.agent_decisions });
  const persisted = await S.replay({ traceId: trace.id, actor: 'owner', persist: true, scenario: { calibrationVersionId: 'calv_hot' } });
  t.ok('persist writes a replay snapshot', persisted.persisted === true && !!persisted.snapshotId && (await S.getSnapshot(persisted.snapshotId)) !== null);
  t.eq('persist did NOT touch any business collection', JSON.stringify({ quotes: data._store.quotes, calibration_versions: data._store.calibration_versions, pricing_recommendations: data._store.pricing_recommendations, agent_decisions: data._store.agent_decisions }), bizBefore);

  // --- listVersions feeds the UI choices ---
  const vers = await S.listVersions('pricing_optimizer');
  t.ok('listVersions returns calibration + policy choices', vers.calibration.some((v) => v.id === 'calv_hot') && vers.policy.some((v) => v.id === pol.version.id));

  // --- honest errors + access control ---
  t.eq('missing trace is an honest error', (await S.replay({ traceId: 'nope', actor: 'owner' })).error, 'TRACE_NOT_FOUND');
  t.eq('AI cannot run the sandbox', (await S.replay({ traceId: trace.id, origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('manager');
  t.eq('manager cannot run the sandbox (owner-only)', (await S.replay({ traceId: trace.id, actor: 'mgr' })).error, 'FORBIDDEN');
  RB.setRole('crew');
  t.eq('crew cannot run the sandbox (owner-only)', (await S.replay({ traceId: trace.id, actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const audit = await GW.recentAudit(200);
  t.ok('every replay attempt is audited (REPLAY_SANDBOX)', audit.some((a) => a.action === 'REPLAY_SANDBOX' && a.decision === 'allowed') && audit.some((a) => a.action === 'REPLAY_SANDBOX' && a.decision === 'denied'));

  return t.report();
};
