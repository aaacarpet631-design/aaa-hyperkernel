/* Model Record Contract v1 — the canonical cross-repo model-registry record
 * (LEVIATHAN Phase 1).
 *
 * Guards: the generated schemas/model-record-v1.json matches document()
 * byte-for-byte + its MANIFEST sha256; the seed catalog is all valid and
 * HONEST (nothing production-approved, everything classification-unverified,
 * unknown → most-restrictive); the openness/lifecycle invariants hold (O5 not
 * redistributable; PRODUCTION_APPROVED requires verified integrity; lifecycle
 * transitions follow the ladder); and the "no lab indispensable" guard works. */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { makeRunner, setupEnv, load, srcPath } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('model-record');
  const { G } = setupEnv();
  load('js/ai/model-record-contract.js');
  const C = G.AAA_MODEL_RECORD;

  // ===== drift guard: committed artifact IS document() =====
  const onDisk = JSON.parse(fs.readFileSync(srcPath('schemas/model-record-v1.json'), 'utf8'));
  t.ok('schemas/model-record-v1.json matches document() byte-for-byte',
    JSON.stringify(onDisk, null, 2) === JSON.stringify(C.document(), null, 2));
  const manifest = JSON.parse(fs.readFileSync(srcPath('schemas/model-record.MANIFEST.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(srcPath('schemas/model-record-v1.json'))).digest('hex');
  t.ok('artifact matches its MANIFEST sha256 (cross-repo parity anchor)', manifest['model-record-v1.json'] === sha);
  t.eq('version is 1.0', C.document().version, '1.0');

  // ===== seed catalog: valid + HONEST =====
  const seed = C.seed();
  t.ok('every seed record validates', seed.every(function (r) { return C.validate(r).ok; }));
  t.ok('NO seed is production-approved (zero production authority by default)',
    seed.every(function (r) { return r.lifecycle !== 'PRODUCTION_APPROVED'; }));
  t.ok('every seed sits at a pre-production lifecycle state', seed.every(function (r) { return r.lifecycle === 'LICENSE_REVIEW'; }));
  t.ok('every seed is classification-unverified (this env cannot verify a license)',
    seed.every(function (r) { return r.classificationVerified === false; }));
  t.ok('every seed integrity is unverified (no signature checked)',
    seed.every(function (r) { return r.integrity.signatureStatus === 'unverified'; }));
  t.ok('the shared ID space links both routers (a provider id on each side exists)',
    seed.some(function (r) { return r.providerIds.custonllm.length; }) && seed.some(function (r) { return r.providerIds.hyperkernel.length; }));

  // ===== openness honesty: O5 is never called open/redistributable =====
  const claude = seed.find(function (r) { return r.modelUid === 'anthropic:claude-opus'; });
  t.ok('a managed API model is O5', claude.opennessClass === 'O5');
  t.ok('O5 is never redistributable', claude.license.redistributionAllowed === false);
  t.ok('an unknown-license model degrades to the restrictive default',
    C.validate(C.normalize({ modelUid: 'x:y', laboratory: 'x' })).ok &&
    C.normalize({ modelUid: 'x:y', laboratory: 'x' }).opennessClass === 'O5' &&
    C.normalize({ modelUid: 'x:y', laboratory: 'x' }).license.commercialUseAllowed === false);

  // ===== validation invariants =====
  t.ok('an O5 marked redistributable is rejected',
    C.validate(C.normalize({ modelUid: 'a:b', laboratory: 'a', opennessClass: 'O5', license: { licenseId: 'x', redistributionAllowed: true } })).ok === false);
  const prodUnverified = C.normalize({ modelUid: 'a:b', laboratory: 'a', opennessClass: 'O2', license: { licenseId: 'apache-2.0', commercialUseAllowed: true, redistributionAllowed: true }, lifecycle: 'PRODUCTION_APPROVED' });
  t.ok('PRODUCTION_APPROVED on an unverified signature is rejected', C.validate(prodUnverified).ok === false);
  t.ok('a bad openness class is rejected', C.validate({ modelUid: 'a', laboratory: 'a', opennessClass: 'O9', lifecycle: 'DISCOVERED', license: { licenseId: 'x', commercialUseAllowed: false, redistributionAllowed: false, fineTuningAllowed: false }, integrity: { signatureStatus: 'unverified' } }).ok === false);

  // ===== lifecycle state machine =====
  t.ok('the ladder advances one step (DISCOVERED → LICENSE_REVIEW)', C.canTransition('DISCOVERED', 'LICENSE_REVIEW'));
  t.ok('the ladder cannot skip gates (DISCOVERED → PRODUCTION_APPROVED refused)', C.canTransition('DISCOVERED', 'PRODUCTION_APPROVED') === false);
  t.ok('any pre-prod state can be REJECTED', C.canTransition('CAPABILITY_EVALUATION', 'REJECTED'));
  t.ok('a production model can be REVOKED/DEPRECATED', C.canTransition('PRODUCTION_APPROVED', 'REVOKED') && C.canTransition('PRODUCTION_APPROVED', 'DEPRECATED'));
  t.ok('a revoked model cannot silently return to production', C.canTransition('REVOKED', 'PRODUCTION_APPROVED') === false);

  // ===== no-lab-indispensable guard =====
  t.ok('vacuously ok while nothing is production-approved', C.noLabIndispensable(seed).ok === true);
  const skewed = [
    { laboratory: 'nvidia', lifecycle: 'PRODUCTION_APPROVED' },
    { laboratory: 'nvidia', lifecycle: 'PRODUCTION_APPROVED' },
    { laboratory: 'nvidia', lifecycle: 'PRODUCTION_APPROVED' },
    { laboratory: 'anthropic', lifecycle: 'PRODUCTION_APPROVED' }
  ];
  const g = C.noLabIndispensable(skewed, 60);
  t.ok('a lab holding >60% of the production fleet is flagged', g.ok === false && g.offenders.indexOf('nvidia') !== -1);
  const balanced = [
    { laboratory: 'nvidia', lifecycle: 'PRODUCTION_APPROVED' },
    { laboratory: 'anthropic', lifecycle: 'PRODUCTION_APPROVED' },
    { laboratory: 'google', lifecycle: 'PRODUCTION_APPROVED' }
  ];
  t.ok('a balanced fleet passes', C.noLabIndispensable(balanced, 60).ok === true);

  return t.report();
};
