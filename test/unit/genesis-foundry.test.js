/* Genesis Council / Dynamic Agent Foundry — DNA schema, gap detection, spawn
 * governance, sandboxed execution, decision logging, graph facts, promotion,
 * termination, and the PHOTO_UPLOADED → bleach-damage-vision-agent demo. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadGenesis() {
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-engine.js');
  load('js/genesis/agent-template-schema.js');
  load('js/genesis/capability-registry.js');
  load('js/genesis/capability-gap-detector.js');
  load('js/genesis/agent-factory.js');
  load('js/genesis/spawn-policy.js');
  load('js/genesis/ephemeral-agent-runtime.js');
  load('js/genesis/promotion-engine.js');
  load('js/genesis/termination-engine.js');
  load('js/genesis/genesis-council.js');
}

const REQUIRED_FIELDS = ['agentId', 'name', 'council', 'action', 'targetEntity', 'triggerEvent',
  'allowedReads', 'allowedWrites', 'forbiddenActions', 'tools', 'maxRuntimeMs', 'maxCostUsd',
  'riskLevel', 'approvalRequired', 'expectedOutputSchema', 'rollbackPlan', 'terminationCondition'];

module.exports = async function run() {
  const t = makeRunner('genesis-foundry');
  const { G, data } = setupEnv();
  loadGenesis();
  const TPL = G.AAA_AGENT_TEMPLATE, REG = G.AAA_CAPABILITY_REGISTRY, GAP = G.AAA_GAP_DETECTOR;
  const FAC = G.AAA_AGENT_FACTORY, RT = G.AAA_EPHEMERAL_RUNTIME;
  const PROMO = G.AAA_PROMOTION_ENGINE, TERM = G.AAA_TERMINATION_ENGINE, COUNCIL = G.AAA_GENESIS_COUNCIL;

  // ===== DNA template schema (the native "Zod") =====
  t.ok('four agent classes A-D are declared', ['A', 'B', 'C', 'D'].every((k) => !!TPL.AGENT_CLASSES[k]));
  t.eq('ten baseline safety rules', TPL.BASELINE_FORBIDDEN.length, 10);
  const spliced0 = FAC.splice({ action: 'detect', entity: 'damage', context: 'bleach stains', domain: 'vision', triggerEvent: 'photo.uploaded' });
  t.ok('factory splices a valid genome', spliced0.ok === true);
  t.ok('spec carries every required schema field', REQUIRED_FIELDS.every((f) => spliced0.spec[f] !== undefined && spliced0.spec[f] !== null));
  const dropped = Object.assign({}, spliced0.spec, { forbiddenActions: spliced0.spec.forbiddenActions.slice(1) });
  t.ok('dropping a baseline safety rule invalidates the spec', TPL.validate(dropped).ok === false);
  const grabby = Object.assign({}, spliced0.spec, { allowedWrites: ['payroll'] });
  t.ok('claiming a protected write (payroll) invalidates the spec', TPL.validate(grabby).ok === false);
  t.ok('genesis may not mint a class-A kernel agent', TPL.validate(Object.assign({}, spliced0.spec, { klass: 'A' })).ok === false);

  // ===== spawning formula: Action + Entity + Context = Ephemeral Agent =====
  t.eq('detect+damage+bleach → bleach-damage-vision-agent', FAC.nameFor('detect', 'damage', 'bleach stains', 'vision'), 'bleach-damage-vision-agent');
  t.eq('verify+invoice+over $10,000 → large-invoice-verification-agent', FAC.nameFor('verify', 'invoice', 'over $10,000', 'finance'), 'large-invoice-verification-agent');
  t.eq('calculate+margin+holiday → holiday-margin-calculator-agent', FAC.nameFor('calculate', 'margin', 'holiday overtime', 'finance'), 'holiday-margin-calculator-agent');
  t.eq('translate+review+korean → korean-review-translation-agent', FAC.nameFor('translate', 'review', 'korean', 'language'), 'korean-review-translation-agent');
  t.eq('the formula is deterministic', FAC.splice({ action: 'detect', entity: 'damage', context: 'bleach stains', domain: 'vision', triggerEvent: 'photo.uploaded' }).spec.name, spliced0.spec.name);

  // ===== capability registry: permanent employees first =====
  t.ok('a permanent agent handles schedule+job (no spawn)', (await REG.canHandle('schedule', 'job')) !== null);
  t.eq('nobody handles detect+damage+bleach (gap)', await REG.canHandle('detect', 'damage', 'bleach stains'), null);

  // ===== honesty: no executor + no proxy → AI_NOT_CONFIGURED, nothing invented =====
  const honest = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph0', jobId: 'j0', tags: ['mold'] });
  t.ok('without a model the run fails honestly', honest.spawned === true && honest.run.status === 'failed' && honest.run.error === 'AI_NOT_CONFIGURED');
  t.eq('a failed run writes NO facts', honest.run.factIds.length, 0);
  t.ok('the failure is still decision-logged', (await data.list('agent_decisions')).some((d) => d.runId === honest.run.id && /failed/.test(d.recommendation)));

  // ===== FIRST DEMONSTRATION: PHOTO_UPLOADED → bleach-damage-vision-agent =====
  RT.setExecutor({
    name: 'mock-vision',
    run: async (spec) => spec.action === 'detect'
      ? { ok: true, output: { assessment: 'Bleach spotting across 3 sq ft of living-room carpet', indicates: 'BleachDamage', severity: 'severe', confidence: 88, recommendation: 'Quote dye-repair or patch' }, costUsd: 0.01 }
      : { ok: true, output: { verdict: 'verified', confidence: 90 }, costUsd: 0.01 }
  });
  const demo = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph1', jobId: 'j1', customerId: 'c1', tags: ['bleach', 'stain'] });
  t.ok('council spawned an ephemeral agent', demo.spawned === true);
  t.eq('…named by the spawning formula', demo.spec.name, 'bleach-damage-vision-agent');
  t.eq('…as a class-C specialist', demo.spec.klass, 'C');
  t.eq('the one narrow task succeeded', demo.run.status, 'succeeded');
  t.ok('a capability gap was recorded and filled', (await GAP.gaps()).some((g) => g.runId === demo.run.id && g.status === 'filled'));
  t.ok('DamageAssessment fact written to its allowed collection', (await data.list('damage_assessments')).some((f) => f.runId === demo.run.id && f.severity === 'severe'));
  const fact = (await RT.graphFacts()).find((f) => f.provenance.runId === demo.run.id);
  t.ok('Knowledge Graph fact: Photo → indicates → BleachDamage', !!fact && fact.from.type === 'photo' && fact.from.id === 'ph1' && fact.rel === 'indicates' && fact.to.label === 'BleachDamage');
  t.ok('fact carries full provenance (run, agent, decision)', !!fact.provenance.agentId && !!fact.provenance.decisionId);
  t.ok('decision logged to agent_decisions (genesis-flagged)', (await data.list('agent_decisions')).some((d) => d.runId === demo.run.id && d.genesis === true && d.confidence === 88));
  t.ok('run terminated: closed + temp context scrubbed', !!demo.run.closedAt && demo.run.contextScrubbed === true && (await data.get('ephemeral_context', demo.run.id)).scrubbed === true);
  const busLog = await G.AAA_EVENT_BUS.log();
  t.ok('genesis.spawned + genesis.terminated on the typed bus', busLog.some((e) => e.type === 'genesis.spawned') && busLog.some((e) => e.type === 'genesis.terminated'));
  t.ok('event chain still verifies (no bypass)', (await G.AAA_EVENT_BUS.verifyChain()).ok === true);
  t.ok('spawn verdicts were appended to the audit ledger', (await data.list('governance_audit')).some((a) => a.type === 'genesis.spawn_policy'));

  // ===== safety: high-risk spawns are HELD, fail-closed =====
  const big = await COUNCIL.handleEvent('invoice.issued', { invoiceId: 'inv1', amount: 15000 });
  t.ok('large-invoice spawn is held for approval, not run', big.spawned === false && !!big.held && big.held.spec.name === 'large-invoice-verification-agent');
  t.ok('held spawn is high-risk + approvalRequired', big.held.spec.riskLevel === 'high' && big.held.spec.approvalRequired === true);
  t.ok('a held spawn opened a governance case', (await data.list('governance_cases')).some((c) => c.guardrail === 'genesis_spawn_policy' && c.status === 'open'));
  t.eq('release without justification is refused', (await COUNCIL.approveHold(big.held.id, { reason: 'ok' })).error, 'JUSTIFICATION_REQUIRED');
  const released = await COUNCIL.approveHold(big.held.id, { reason: 'Verified the PO with the property manager by phone.' });
  t.ok('human release (with reason) executes the held spawn', released.ok === true && released.result.run.status === 'succeeded');
  t.eq('routine invoices imply no agent work at all', (await COUNCIL.handleEvent('invoice.issued', { invoiceId: 'inv2', amount: 500 })).reason, 'no_need');

  // ===== safety: agents may not spawn agents =====
  const spawnception = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph2', tags: ['bleach'] }, { spawnedByAgent: true });
  t.ok('an agent spawning an agent is denied without council approval', spawnception.spawned === false && spawnception.denied === true);

  // ===== sandbox: reads and output contract are enforced mechanically =====
  t.eq('reading outside allowedReads is denied', (await RT.read(demo.spec, 'payroll')).error, 'READ_DENIED');
  RT.setExecutor({ name: 'bad-output', run: async () => ({ ok: true, output: { wrong: 'shape' }, costUsd: 0 }) });
  const badOut = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph3', tags: ['pet', 'urine'] });
  t.ok('schema-invalid output fails the run and writes no facts', badOut.run.status === 'failed' && badOut.run.error === 'OUTPUT_SCHEMA_INVALID' && badOut.run.factIds.length === 0);

  // ===== promotion: five rules, computed from real runs =====
  RT.setExecutor({ name: 'mock-vision', run: async () => ({ ok: true, output: { assessment: 'a', indicates: 'BleachDamage', severity: 'minor', confidence: 80 }, costUsd: 0.01 }) });
  const before = await PROMO.evaluate('bleach-damage-vision-agent');
  t.ok('not eligible before 5 spawns', before.eligible === false && before.failed.some((f) => /spawned/.test(f)));
  for (let i = 0; i < 4; i++) await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph_loop' + i, tags: ['bleach'] }, { savedMs: 60000 });
  const after = await PROMO.evaluate('bleach-damage-vision-agent');
  t.ok('eligible after 5+ spawns, ≥80% success, low-risk, time saved',
    after.eligible === true && after.stats.spawns >= 5 && after.stats.successRate >= 0.8 && after.stats.allLowRisk && after.stats.savedMs > 0);
  const need = { action: demo.spec.action, entity: demo.spec.targetEntity, context: demo.spec.context };
  const prop = await PROMO.propose('bleach-damage-vision-agent', need);
  t.ok('eligible agent gets a pending proposal', prop.ok === true && prop.proposal.status === 'pending_governance');
  t.eq('promotion without a written reason is refused', (await PROMO.approve(prop.proposal.id, { reason: 'yes' })).error, 'JUSTIFICATION_REQUIRED');
  const approved = await PROMO.approve(prop.proposal.id, { reason: 'Five clean assessments; saves a site visit per photo.' });
  t.ok('governance-approved promotion registers the capability', approved.ok === true && (await REG.canHandle('detect', 'damage', demo.spec.context)) !== null);
  const nowPermanent = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'ph9', tags: ['bleach', 'stain'] });
  t.eq('next event is handled by the promoted PERMANENT agent — no spawn', nowPermanent.handledBy, 'permanent');
  t.ok('a failing temp is never promotable', (await PROMO.evaluate('no-such-agent')).eligible === false);

  // ===== termination: rollback tombstones facts, never erases =====
  const rb = await TERM.rollback(demo.run.id, { reason: 'test rollback' });
  t.ok('rollback retracts this run’s graph facts', rb.ok === true && rb.retracted >= 1);
  t.ok('retracted facts are tombstoned, not deleted', (await data.list('graph_facts')).some((f) => f.provenance && f.provenance.runId === demo.run.id && f.retracted === true));
  t.ok('close is idempotent', (await TERM.close(demo.run.id)).already === true);

  // ===== wiring =====
  t.ok('install() wires the gap detector to the bus', COUNCIL.install().wired >= 3);
  t.ok('genesis lifecycle contracts registered on the typed bus', !!G.AAA_EVENT_BUS.contract('genesis.spawned') && !!G.AAA_EVENT_BUS.contract('photo.uploaded'));

  return t.report();
};
