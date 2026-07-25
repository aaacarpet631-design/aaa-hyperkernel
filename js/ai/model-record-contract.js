/*
 * AAA Model Record Contract v1 — the ONE canonical model-registry record both
 * repos share. OPERATION LEVIATHAN Phase 1 (docs/LEVIATHAN_PHASE0_INVENTORY.md,
 * docs/ATLAS_TARGET_ARCHITECTURE.md Domain 8).
 *
 * The audit found the two repos run SEPARATE model routers with no shared
 * registry or ID space, and that the openness/license/integrity spine is 0%.
 * This contract defines the single canonical record — keyed by a stable
 * `modelUid` — that links HyperKernel governance (AAA_GOVERNED_MODEL_ROUTER +
 * tenant-model-policy) and Custonllm intelligence (llm.py adapters +
 * trust/policy.py UCB router) to ONE model identity, and carries the
 * openness / license / integrity / lifecycle fields the fabric needs.
 *
 * HONESTY BY CONSTRUCTION — the mission is explicit that "open source must be
 * handled carefully" and "a newly discovered model has zero production
 * authority":
 *   - openness/license here are BEST-EFFORT classifications flagged
 *     classificationVerified:false — this environment cannot verify a license
 *     text hash or an artifact signature, so nothing claims to be verified;
 *   - integrity.signatureStatus defaults to 'unverified';
 *   - NO seed is PRODUCTION_APPROVED — every seed sits at a pre-production
 *     lifecycle state (LICENSE_REVIEW), exactly as the mission requires;
 *   - unknown license → the MOST restrictive default (O5 / no commercial /
 *     no redistribution / no fine-tune), never the most permissive.
 *
 * Same proven pattern as the copilot + governance-policy contracts: this
 * module is the source of truth; schemas/model-record-v1.json is GENERATED
 * from it; a conformance test asserts byte parity; Custonllm reads a
 * byte-identical committed copy anchored by a shared sha256 MANIFEST. Field
 * set is frozen for v1; discovery, verification wiring, and capability-derived
 * scores are later LEVIATHAN phases.
 */
;(function (global) {
  'use strict';

  const VERSION = '1.0';

  // O1 fully open · O2 open weight · O3 restricted open weight · O4 source
  // available · O5 managed-only (API). O5 models must NEVER be called open.
  const OPENNESS_CLASSES = ['O1', 'O2', 'O3', 'O4', 'O5'];

  // The mission's lifecycle state machine. No model reaches PRODUCTION_APPROVED
  // without passing every gate; terminal states are separate.
  const LIFECYCLE = ['DISCOVERED', 'LICENSE_REVIEW', 'QUARANTINED', 'INTEGRITY_VERIFIED',
    'COMPATIBILITY_TESTING', 'CAPABILITY_EVALUATION', 'SAFETY_EVALUATION', 'SHADOW_APPROVED',
    'PRODUCTION_APPROVED'];
  const TERMINAL = ['RESTRICTED', 'DEPRECATED', 'REVOKED', 'REJECTED'];
  const ALL_STATES = LIFECYCLE.concat(TERMINAL);

  // Forward transitions along the ladder, plus any state may be sent to a
  // terminal state (REJECTED/QUARANTINED/RESTRICTED/REVOKED/DEPRECATED) by a
  // governed human action. Enforced by canTransition().
  const NEXT = {
    DISCOVERED: ['LICENSE_REVIEW', 'QUARANTINED', 'REJECTED'],
    LICENSE_REVIEW: ['INTEGRITY_VERIFIED', 'RESTRICTED', 'REJECTED'],
    QUARANTINED: ['INTEGRITY_VERIFIED', 'REJECTED'],
    INTEGRITY_VERIFIED: ['COMPATIBILITY_TESTING', 'REJECTED'],
    COMPATIBILITY_TESTING: ['CAPABILITY_EVALUATION', 'REJECTED'],
    CAPABILITY_EVALUATION: ['SAFETY_EVALUATION', 'REJECTED'],
    SAFETY_EVALUATION: ['SHADOW_APPROVED', 'REJECTED'],
    SHADOW_APPROVED: ['PRODUCTION_APPROVED', 'REJECTED'],
    PRODUCTION_APPROVED: ['DEPRECATED', 'REVOKED', 'RESTRICTED']
  };

  const MODALITIES = ['text', 'image', 'audio', 'video', 'embedding'];

  function str(v) { return v == null ? null : String(v); }
  function bool(v) { return !!v; }
  function arr(v) { return Array.isArray(v) ? v.slice() : []; }

  // Conservative license default — the most restrictive posture for an unknown.
  function conservativeLicense() {
    return { licenseId: 'UNKNOWN', licenseTextHash: null, commercialUseAllowed: false, redistributionAllowed: false, fineTuningAllowed: false };
  }

  /**
   * Normalize a partial record into a complete canonical record. Never throws.
   * Unknown/missing fields degrade to the SAFE (restrictive/unverified) side.
   */
  function normalize(input) {
    const i = input || {};
    const lic = i.license || {};
    const integ = i.integrity || {};
    const caps = i.capabilities || {};
    const pids = i.providerIds || {};
    const openness = OPENNESS_CLASSES.indexOf(i.opennessClass) !== -1 ? i.opennessClass : 'O5';
    const lifecycle = ALL_STATES.indexOf(i.lifecycle) !== -1 ? i.lifecycle : 'DISCOVERED';
    return {
      modelUid: str(i.modelUid),
      laboratory: str(i.laboratory),
      family: str(i.family),
      displayName: str(i.displayName) || str(i.modelUid),
      opennessClass: openness,
      classificationVerified: bool(i.classificationVerified), // false until a human verifies
      license: {
        licenseId: str(lic.licenseId) || 'UNKNOWN',
        licenseTextHash: str(lic.licenseTextHash),
        commercialUseAllowed: bool(lic.commercialUseAllowed),
        redistributionAllowed: bool(lic.redistributionAllowed),
        fineTuningAllowed: bool(lic.fineTuningAllowed)
      },
      integrity: {
        signatureStatus: ['unverified', 'verified', 'failed'].indexOf(integ.signatureStatus) !== -1 ? integ.signatureStatus : 'unverified',
        weightHashes: arr(integ.weightHashes),
        artifactRevision: str(integ.artifactRevision)
      },
      capabilities: {
        modalities: arr(caps.modalities).filter(function (m) { return MODALITIES.indexOf(m) !== -1; }),
        contextWindow: caps.contextWindow != null && isFinite(+caps.contextWindow) ? +caps.contextWindow : null,
        toolCalling: bool(caps.toolCalling),
        structuredOutput: bool(caps.structuredOutput)
      },
      runtimes: arr(i.runtimes).map(String),
      providerIds: { hyperkernel: arr(pids.hyperkernel).map(String), custonllm: arr(pids.custonllm).map(String) },
      lifecycle: lifecycle,
      approvedTaskClasses: arr(i.approvedTaskClasses).map(String),
      prohibitedTaskClasses: arr(i.prohibitedTaskClasses).map(String)
    };
  }

  // ---- the seed catalog: the models actually in the two repos' code today ---
  // Best-effort openness/license, classificationVerified:false, integrity
  // unverified, lifecycle LICENSE_REVIEW (pre-production). Conservative where
  // uncertain — never overclaims openness. providerIds tie the two routers'
  // keys to one modelUid (the shared ID space the audit found missing).
  const SEED = [
    { modelUid: 'anthropic:claude-opus', laboratory: 'anthropic', family: 'claude', displayName: 'Claude Opus',
      opennessClass: 'O5', license: { licenseId: 'anthropic-commercial-tos', commercialUseAllowed: true },
      capabilities: { modalities: ['text', 'image'], toolCalling: true, structuredOutput: true }, runtimes: ['anthropic'],
      providerIds: { custonllm: ['claude-opus'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'anthropic:claude-sonnet', laboratory: 'anthropic', family: 'claude', displayName: 'Claude Sonnet',
      opennessClass: 'O5', license: { licenseId: 'anthropic-commercial-tos', commercialUseAllowed: true },
      capabilities: { modalities: ['text', 'image'], toolCalling: true, structuredOutput: true }, runtimes: ['anthropic'],
      providerIds: { custonllm: ['claude-sonnet'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nousresearch:hermes-4-405b', laboratory: 'nousresearch', family: 'hermes-4', displayName: 'Hermes 4 405B',
      opennessClass: 'O3', license: { licenseId: 'llama-3.1-community', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'], toolCalling: true }, runtimes: ['openrouter', 'nous'],
      providerIds: { custonllm: ['hermes-4-405b', 'hermes-4-405b-nous'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nousresearch:hermes-4-70b', laboratory: 'nousresearch', family: 'hermes-4', displayName: 'Hermes 4 70B',
      opennessClass: 'O3', license: { licenseId: 'llama-3.1-community', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'], toolCalling: true }, runtimes: ['openrouter'],
      providerIds: { custonllm: ['hermes-4-70b'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nousresearch:hermes-3-405b', laboratory: 'nousresearch', family: 'hermes-3', displayName: 'Hermes 3 405B',
      opennessClass: 'O3', license: { licenseId: 'llama-3.1-community', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'], toolCalling: true }, runtimes: ['openrouter'],
      providerIds: { custonllm: ['hermes-3-405b'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nvidia:nemotron-super-49b', laboratory: 'nvidia', family: 'nemotron', displayName: 'Llama Nemotron Super 49B',
      opennessClass: 'O3', license: { licenseId: 'nvidia-open-model', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'], toolCalling: true }, runtimes: ['nvidia'],
      providerIds: { custonllm: ['nemotron-super-49b'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nvidia:nemotron-3-ultra', laboratory: 'nvidia', family: 'nemotron', displayName: 'Nemotron 3 Ultra 550B',
      opennessClass: 'O3', license: { licenseId: 'nvidia-open-model', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'], toolCalling: true }, runtimes: ['nvidia'],
      providerIds: { custonllm: ['nemotron-3-ultra'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'nvidia:nemotron-4-340b', laboratory: 'nvidia', family: 'nemotron-4', displayName: 'Nemotron-4 340B',
      opennessClass: 'O3', license: { licenseId: 'nvidia-open-model', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'] }, runtimes: ['nim', 'huggingface'],
      providerIds: { hyperkernel: ['nvidia.nemotron4_340b_base', 'nvidia.nemotron4_340b_instruct', 'nvidia.nemotron4_340b_reward'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'google:diffusiongemma-26b', laboratory: 'google', family: 'gemma-4', displayName: 'DiffusionGemma 26B',
      opennessClass: 'O3', license: { licenseId: 'gemma', commercialUseAllowed: true, fineTuningAllowed: true },
      capabilities: { modalities: ['text'] }, runtimes: ['nvidia'],
      providerIds: { custonllm: ['diffusiongemma-26b'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'minimax:minimax-m3', laboratory: 'minimax', family: 'minimax-m3', displayName: 'MiniMax M3',
      opennessClass: 'O3', license: { licenseId: 'minimax-open-weight', commercialUseAllowed: true },
      capabilities: { modalities: ['text', 'image', 'video'], toolCalling: true, contextWindow: 1000000 }, runtimes: ['nvidia'],
      providerIds: { custonllm: ['minimax-m3'] }, lifecycle: 'LICENSE_REVIEW' },
    { modelUid: 'private:local-gpu', laboratory: 'operator', family: 'private-gpu', displayName: 'Private GPU Model (operator-supplied)',
      opennessClass: 'O5', license: conservativeLicense(),
      capabilities: { modalities: ['text'] }, runtimes: ['openai_compat', 'vllm'],
      providerIds: { hyperkernel: ['privategpu.local'] }, lifecycle: 'LICENSE_REVIEW' }
  ];

  const Contract = {
    VERSION: VERSION,
    OPENNESS_CLASSES: OPENNESS_CLASSES.slice(),
    LIFECYCLE_STATES: ALL_STATES.slice(),

    /** Strict validation — names every gap. Never throws. */
    validate: function (record) {
      const issues = [];
      const r = record || {};
      if (!r.modelUid) issues.push('modelUid required');
      if (!r.laboratory) issues.push('laboratory required');
      if (OPENNESS_CLASSES.indexOf(r.opennessClass) === -1) issues.push('opennessClass must be O1-O5');
      if (ALL_STATES.indexOf(r.lifecycle) === -1) issues.push('lifecycle must be a known state');
      if (!r.license || typeof r.license !== 'object') issues.push('license required');
      else {
        if (!r.license.licenseId) issues.push('license.licenseId required');
        ['commercialUseAllowed', 'redistributionAllowed', 'fineTuningAllowed'].forEach(function (k) {
          if (typeof r.license[k] !== 'boolean') issues.push('license.' + k + ' must be boolean');
        });
      }
      if (!r.integrity || ['unverified', 'verified', 'failed'].indexOf(r.integrity.signatureStatus) === -1) issues.push('integrity.signatureStatus must be unverified/verified/failed');
      // An O5 (managed/API) model may never be described as redistributable —
      // the mission's hard rule that O5 is not open source.
      if (r.opennessClass === 'O5' && r.license && r.license.redistributionAllowed === true) issues.push('O5 (managed-only) cannot be redistributable');
      // Production authority requires verified integrity — no PRODUCTION_APPROVED
      // model may sit on an unverified signature.
      if (r.lifecycle === 'PRODUCTION_APPROVED' && (!r.integrity || r.integrity.signatureStatus !== 'verified')) issues.push('PRODUCTION_APPROVED requires integrity.signatureStatus=verified');
      return issues.length ? { ok: false, issues: issues } : { ok: true };
    },

    /** Is a lifecycle transition allowed? (forward ladder + governed terminals) */
    canTransition: function (from, to) {
      if (ALL_STATES.indexOf(to) === -1) return false;
      return (NEXT[from] || []).indexOf(to) !== -1;
    },

    /** The seed catalog as complete, validated canonical records. */
    seed: function () { return SEED.map(normalize); },

    normalize: normalize,

    /**
     * "No laboratory indispensable" (mission final directive) as an executable
     * guard: among PRODUCTION_APPROVED records, no single laboratory may exceed
     * `floorPct` (default 60%) of the approved fleet. Returns {ok, offenders}.
     * Vacuously ok while nothing is production-approved yet.
     */
    noLabIndispensable: function (records, floorPct) {
      const floor = floorPct != null ? floorPct : 60;
      const approved = (records || []).filter(function (r) { return r && r.lifecycle === 'PRODUCTION_APPROVED'; });
      if (!approved.length) return { ok: true, offenders: [], approved: 0 };
      const byLab = {};
      approved.forEach(function (r) { byLab[r.laboratory] = (byLab[r.laboratory] || 0) + 1; });
      const offenders = Object.keys(byLab).filter(function (lab) { return (byLab[lab] / approved.length) * 100 > floor; });
      return { ok: offenders.length === 0, offenders: offenders, approved: approved.length };
    },

    /** The full contract document — source for schemas/model-record-v1.json. */
    document: function () {
      return {
        version: VERSION,
        opennessClasses: OPENNESS_CLASSES.slice(),
        lifecycleStates: { ladder: LIFECYCLE.slice(), terminal: TERMINAL.slice() },
        transitions: JSON.parse(JSON.stringify(NEXT)),
        seed: SEED.map(normalize)
      };
    }
  };

  global.AAA_MODEL_RECORD = Contract;
})(typeof window !== 'undefined' ? window : this);
