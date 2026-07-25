/* LEVIATHAN Domain-8 STEP 2 (HyperKernel side): the serving model registry
 * resolves into the canonical model record's shared ID space, and the
 * dual-read reconciliation proves the two cannot drift. Nothing is gated on
 * the canonical record yet — these are shadow reads; the honesty invariant
 * (nothing production-approved) must hold through the resolution layer. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('model-registry-canonical');
  const { G } = setupEnv();
  load('js/ai/model-record-contract.js');
  load('js/ai/model-registry.js');
  const REG = G.AAA_MODEL_REGISTRY, C = G.AAA_MODEL_RECORD;

  // ===== reconciliation: the CI drift tripwire =====
  const rec = REG.reconcile();
  t.ok('every registry key maps to exactly one canonical record', rec.ok === true && rec.unmapped.length === 0);
  t.ok('every canonical hyperkernel provider id exists in the registry (mirror of the custonllm conformance test)', rec.unknownRefs.length === 0);
  t.eq('all ' + REG.keys().length + ' registry keys are mapped', Object.keys(rec.mapped).length, REG.keys().length);

  // ===== the shared ID space resolves to the expected canonical uids =====
  t.eq('nemotron instruct resolves to the canonical nemotron-4 record', REG.modelUidOf('nvidia.nemotron4_340b_instruct'), 'nvidia:nemotron-4-340b');
  t.eq('nemotron base and reward share the same canonical model', REG.modelUidOf('nvidia.nemotron4_340b_base'), REG.modelUidOf('nvidia.nemotron4_340b_reward'));
  t.eq('the private GPU key resolves to the operator record', REG.modelUidOf('privategpu.local'), 'private:local-gpu');

  // ===== resolved records are valid canonical records =====
  REG.keys().forEach(function (key) {
    const r = REG.canonicalRecord(key);
    const v = C.validate(r);
    t.ok('canonical record behind ' + key + ' validates', v.ok === true);
  });

  // ===== the shadow lifecycle gate is HONEST =====
  REG.keys().forEach(function (key) {
    const gate = REG.lifecycleGate(key);
    t.ok(key + ': lifecycle gate known + NOT production-approved (nothing is, yet)', gate.known === true && gate.productionApproved === false && gate.lifecycle === 'LICENSE_REVIEW');
  });

  // ===== null tolerance / honest edges =====
  t.ok('unknown key resolves to null', REG.canonicalRecord('nvidia.made_up') === null && REG.modelUidOf('nvidia.made_up') === null);
  t.ok('unknown key gate is known:false and never approved', REG.lifecycleGate('nvidia.made_up').known === false && REG.lifecycleGate('nvidia.made_up').productionApproved === false);
  t.ok('null key tolerated', REG.canonicalRecord(null) === null);
  // With the contract absent, readers degrade instead of lying.
  const savedContract = G.AAA_MODEL_RECORD;
  delete G.AAA_MODEL_RECORD;
  t.ok('without the contract, resolution is null (no fake identity)', REG.canonicalRecord('privategpu.local') === null);
  t.ok('without the contract, reconcile reports NO_CANONICAL_CONTRACT (never ok:true)', REG.reconcile().ok === false && REG.reconcile().error === 'NO_CANONICAL_CONTRACT');
  t.ok('without the contract, the gate never approves', REG.lifecycleGate('privategpu.local').productionApproved === false);
  G.AAA_MODEL_RECORD = savedContract;

  return t.report();
};
