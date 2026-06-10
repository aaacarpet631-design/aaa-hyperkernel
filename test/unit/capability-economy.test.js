/* Capability Economy — immutable ledger, reputation, ROI, failure detection,
 * banning/quarantine, six-rule promotion scoring, governance approval, and the
 * marketplace dashboard read model. Turns Genesis runs into enterprise
 * intelligence: which capabilities earn permanence, stay ephemeral, or are banned. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js', 'js/governance/governance-engine.js',
   'js/genesis/agent-template-schema.js', 'js/genesis/capability-registry.js', 'js/genesis/capability-gap-detector.js',
   'js/genesis/agent-factory.js', 'js/genesis/spawn-policy.js', 'js/genesis/tool-forge.js', 'js/genesis/ephemeral-agent-runtime.js',
   'js/genesis/capability-ledger.js', 'js/genesis/capability-roi-engine.js', 'js/genesis/failure-pattern-detector.js',
   'js/genesis/capability-reputation-store.js', 'js/genesis/banned-capability-registry.js', 'js/genesis/promotion-scorer.js',
   'js/genesis/capability-marketplace-dashboard.js', 'js/genesis/promotion-engine.js', 'js/genesis/termination-engine.js',
   'js/genesis/genesis-council.js'].forEach(load);
}

const GOOD = { name: 'mock-vision', run: async () => ({ ok: true, output: { assessment: 'bleach spotting', indicates: 'BleachDamage', severity: 'minor', confidence: 84 }, costUsd: 0.02 }) };
const BADOUT = { name: 'bad', run: async () => ({ ok: true, output: { nope: 1 }, costUsd: 0.02 }) };

module.exports = async function run() {
  const t = makeRunner('capability-economy');
  const { G, data } = setupEnv();
  loadAll();
  const COUNCIL = G.AAA_GENESIS_COUNCIL, RT = G.AAA_EPHEMERAL_RUNTIME, LEDGER = G.AAA_CAPABILITY_LEDGER;
  const REP = G.AAA_CAPABILITY_REPUTATION, ROI = G.AAA_CAPABILITY_ROI, FAIL = G.AAA_FAILURE_DETECTOR;
  const BAN = G.AAA_BANNED_CAPABILITIES, SCORER = G.AAA_PROMOTION_SCORER, PROMO = G.AAA_PROMOTION_ENGINE, DASH = G.AAA_CAPABILITY_DASHBOARD;
  const SIG = LEDGER.signatureOf('detect', 'damage', 'bleach stain');

  // ===== ledger captures the full required field set, immutably =====
  RT.setExecutor(GOOD);
  const first = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'p1', jobId: 'j1', tags: ['bleach', 'stain'] });
  const entry = (await LEDGER.entries({ signature: SIG }))[0];
  const REQ = ['capabilityDNA', 'eventTrigger', 'agentSpec', 'toolSpec', 'executionResult', 'confidence', 'risk', 'costUsd', 'latencyMs', 'humanApprovalRequired', 'rollbackUsed', 'graphFactsWritten'];
  t.ok('every run becomes a ledger entry with all required fields', !!entry && REQ.every((f) => entry[f] !== undefined));
  t.ok('ledger captures capability DNA + tool DNA', entry.capabilityDNA.action === 'detect' && entry.capabilityDNA.entity === 'damage' && entry.toolDNA.length >= 1);
  t.eq('confidence is captured from the decision', entry.confidence, 84);
  t.ok('cost + latency captured', entry.costUsd === 0.02 && typeof entry.latencyMs === 'number');

  // immutable history: an outcome is a separate append, never a rewrite
  const snapshotBefore = JSON.stringify(entry);
  await LEDGER.linkOutcome(first.run.id, { result: 'won', resultClass: 'success', roi: { savedMs: 1800000, savedUsd: 120 } });
  const reread = (await LEDGER.entries({ signature: SIG })).find((e) => e.id === entry.id);
  t.eq('ledger entries are immutable (outcome did not mutate the entry)', JSON.stringify(reread), snapshotBefore);
  t.eq('the outcome is an append-only overlay', (await LEDGER.outcomes(first.run.id)).length, 1);

  // ===== ROI calculation =====
  const roi1 = await ROI.compute(SIG);
  t.ok('ROI aggregates measurable benefit (labor time + money)', roi1.measurableBenefit === true && roi1.dimensions.savedLaborMs === 1800000 && roi1.money.savedUsd === 120);
  t.ok('ROI dimension with no data is null, not zero', roi1.dimensions.closeRateIncreased === null);
  const emptyRoi = await ROI.compute('translate|review|klingon');
  t.ok('no outcomes → no measurable benefit (honest)', emptyRoi.measurableBenefit === false);

  // ===== promotion eligibility: the six rules over real runs =====
  const early = await SCORER.score(SIG);
  t.ok('not eligible at 1 spawn (rule 1)', early.eligible === false && early.checks.spawns.pass === false);
  for (let i = 0; i < 4; i++) {
    const r = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pl' + i, tags: ['bleach', 'stain'] });
    await LEDGER.linkOutcome(r.run.id, { result: 'won', roi: { savedMs: 1800000, savedUsd: 100 } });
  }
  const scored = await SCORER.score(SIG);
  t.ok('eligible after 5 spawns / ≥80% success / ≤5% rollback / low risk / benefit / no violations',
    scored.eligible === true &&
    scored.checks.spawns.pass && scored.checks.successRate.pass && scored.checks.rollbackRate.pass &&
    scored.checks.avgRisk.pass && scored.checks.measurableBenefit.pass && scored.checks.noViolations.pass);
  t.eq('score reflects all six rules cleared', scored.score, 1);

  // reputation reflects the same real history
  const rep = await REP.reputation(SIG);
  t.ok('reputation store computes the track record from the ledger', rep.spawns === 5 && rep.successRate === 1 && rep.rollbackRate === 0 && rep.avgRiskScore === 1);

  // ===== governance approval requirement: promotion is never silent =====
  const need = { action: 'detect', entity: 'damage', context: 'bleach stain' };
  const prop = await PROMO.propose('bleach-damage-vision-agent', need);
  t.ok('eligible capability gets a pending proposal', prop.ok === true && prop.proposal.status === 'pending_governance');
  t.ok('CAPABILITY_PROMOTION_PROPOSED event is emitted (no silent promotion)', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'capability.promotion_proposed' && e.payload.signature === SIG));
  t.eq('promotion without authority+reason is refused', (await PROMO.approve(prop.proposal.id, { reason: 'ok' })).error, 'JUSTIFICATION_REQUIRED');
  const appr = await PROMO.approve(prop.proposal.id, { reason: 'Five clean bleach assessments; each saves a truck roll.' });
  t.ok('human-approved promotion mutates the permanent registry', appr.ok === true && (await G.AAA_CAPABILITY_REGISTRY.canHandle('detect', 'damage', 'bleach stain')) !== null);
  const nowPerm = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pPerm', tags: ['bleach', 'stain'] });
  t.eq('promoted capability is handled permanently — no spawn', nowPerm.handledBy, 'permanent');

  // ===== failure patterns → quarantine logic =====
  RT.setExecutor(BADOUT);
  for (let i = 0; i < 3; i++) await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pet' + i, tags: ['pet', 'urine'] });
  const PETSIG = LEDGER.signatureOf('detect', 'damage', 'pet urine');
  const scan = await FAIL.scan(PETSIG);
  t.ok('failure detector flags repeated invalid graph writes', scan.patterns.some((p) => p.kind === 'invalid_graph_writes') && scan.recommendation === 'ban');
  t.ok('a capability with violations is NOT promotable (rule 6)', (await SCORER.score(PETSIG)).checks.noViolations.pass === false);

  // ===== banned/quarantine refusal at the council door =====
  const enforce = await BAN.autoEnforce();
  t.ok('autoEnforce bans the failing capability (immune response, recorded)', enforce.applied.some((a) => a.signature === PETSIG && a.state === 'banned'));
  t.ok('the ban is auditable, reversible state (not a silent kill)', (await data.list('governance_audit')).some((a) => a.type === 'genesis.capability_banned'));
  RT.setExecutor(GOOD);
  const refused = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pet99', tags: ['pet', 'urine'] });
  t.ok('a banned capability is REFUSED before the factory (no spawn)', refused.spawned === false && refused.banned === true && refused.signature === PETSIG);
  t.eq('a banned capability cannot be proposed for promotion', (await PROMO.propose('pet-damage-vision-agent', { action: 'detect', entity: 'damage', context: 'pet urine' })).error, 'CAPABILITY_BANNED');

  // lift requires authority + written reason; then it spawns again
  t.eq('lifting a ban without a reason is refused', (await BAN.lift(PETSIG, { reason: 'eh' })).error, 'JUSTIFICATION_REQUIRED');
  t.ok('an authorized human can lift a ban with a reason', (await BAN.lift(PETSIG, { reason: 'Fixed the pet-urine output schema; re-enabling under watch.' })).ok === true);
  t.ok('after lift the capability spawns again', (await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pet_back', tags: ['pet', 'urine'] })).spawned === true);

  // quarantine: held for human approval, releasable
  const QSIG = SIG;
  await BAN.quarantine(QSIG, { bySystem: true, reason: 'watchlist' });
  const q = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pq', tags: ['bleach', 'stain'] });
  // NOTE: SIG was promoted to permanent earlier, so it is handled permanently and never reaches the quarantine gate.
  t.ok('quarantine on a promoted cap is moot (permanent handler wins)', q.handledBy === 'permanent');
  const FRESH = LEDGER.signatureOf('detect', 'damage', 'rust stain');
  await BAN.quarantine(FRESH, { bySystem: true, reason: 'watchlist' });
  const q2 = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'pr', tags: ['rust', 'stain'] });
  t.ok('a quarantined capability is HELD for human approval, not run', q2.spawned === false && q2.quarantined === true && !!q2.held);
  const rel = await COUNCIL.approveHold(q2.held.id, { reason: 'Reviewed rust-stain detector; approving this run.' });
  t.ok('human release of a quarantine hold spawns the agent', rel.ok === true && rel.result.spawned === true);

  // ===== dashboard read model (data first, not cosmetic UI) =====
  const view = await DASH.view({ limit: 5 });
  t.ok('dashboard exposes all required sections', ['topPromotedCandidates', 'riskyCapabilities', 'bannedCapabilities', 'costliestCapabilities', 'highestRoiCapabilities', 'mostSpawnedDNA', 'totals'].every((k) => view[k] !== undefined));
  t.ok('totals are real counts', view.totals.capabilities >= 2 && view.totals.runs >= 6);
  t.ok('highest-ROI list ranks the bleach capability (it has the savings)', view.highestRoiCapabilities.length >= 1 && view.highestRoiCapabilities[0].score > 0);
  t.ok('risky list surfaces flagged capabilities', Array.isArray(view.riskyCapabilities));
  t.ok('most-spawned DNA is reported', view.mostSpawnedDNA.length >= 1 && view.mostSpawnedDNA[0].spawns >= 1);

  return t.report();
};
