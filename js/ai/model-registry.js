/*
 * AAA Model Registry — provider-neutral catalog of the external intelligence
 * engines the Governed Model Router may call.
 *
 * This holds only METADATA (family, variant, allowed tasks, risk tier, exposure)
 * and DOCUMENTED CANDIDATE ids per runtime. It deliberately does NOT hard-code the
 * operative model id into the call path: the id the adapter actually sends comes
 * from the model's GOVERNED ARTIFACT content (owner-confirmed at activation), so a
 * wrong/renamed provider id can never silently ship. The candidates here are
 * flagged `verified:false` and surfaced in the UI as "confirm before activation".
 *
 * NVIDIA models are intelligence engines, not authority engines.
 */
;(function (global) {
  'use strict';

  const FAMILY = 'nemotron-4';
  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }

  const MODELS = {
    'nvidia.nemotron4_340b_base': {
      key: 'nvidia.nemotron4_340b_base', family: FAMILY, variant: 'base', label: 'Nemotron-4 340B Base',
      provider: 'nvidia', riskTier: 'medium', customerFacing: false, exposure: 'internal',
      allowedTasks: ['synthetic_training_case', 'scenario_generation'],
      candidates: { huggingface: 'nvidia/Nemotron-4-340B-Base', nim: 'nvidia/nemotron-4-340b-base' }
    },
    'nvidia.nemotron4_340b_instruct': {
      key: 'nvidia.nemotron4_340b_instruct', family: FAMILY, variant: 'instruct', label: 'Nemotron-4 340B Instruct',
      provider: 'nvidia', riskTier: 'high', customerFacing: false, exposure: 'advisory',
      allowedTasks: ['draft_customer_message', 'owner_briefing_explanation', 'executive_council_reasoning'],
      candidates: { huggingface: 'nvidia/Nemotron-4-340B-Instruct', nim: 'nvidia/nemotron-4-340b-instruct' }
    },
    'nvidia.nemotron4_340b_reward': {
      key: 'nvidia.nemotron4_340b_reward', family: FAMILY, variant: 'reward', label: 'Nemotron-4 340B Reward',
      provider: 'nvidia', riskTier: 'low', customerFacing: false, exposure: 'scoring',
      allowedTasks: ['agent_output_score', 'recommendation_rank', 'proposal_quality_score'],
      candidates: { huggingface: 'nvidia/Nemotron-4-340B-Reward', nim: 'nvidia/nemotron-4-340b-reward' }
    },
    // Private, self-hosted GPU model (OpenAI-style /v1/chat/completions). The
    // operative modelId + endpoint live server-side; the owner confirms the served
    // model name when activating the governed artifact.
    'privategpu.local': {
      key: 'privategpu.local', family: 'private-gpu', variant: 'instruct', label: 'Private GPU Model (OpenAI-compatible)',
      provider: 'private_gpu', riskTier: 'medium', customerFacing: false, exposure: 'advisory',
      allowedTasks: ['draft_customer_message', 'owner_briefing_explanation', 'executive_council_reasoning', 'scenario_generation', 'synthetic_training_case'],
      candidates: { local: 'local-model', openai_compat: 'local-model' }
    }
  };

  // task → model key (the canonical routing table).
  const TASK_ROUTING = {
    draft_customer_message: 'nvidia.nemotron4_340b_instruct',
    owner_briefing_explanation: 'nvidia.nemotron4_340b_instruct',
    executive_council_reasoning: 'nvidia.nemotron4_340b_instruct',
    synthetic_training_case: 'nvidia.nemotron4_340b_base',
    scenario_generation: 'nvidia.nemotron4_340b_base',
    agent_output_score: 'nvidia.nemotron4_340b_reward',
    recommendation_rank: 'nvidia.nemotron4_340b_reward',
    proposal_quality_score: 'nvidia.nemotron4_340b_reward'
  };

  const Registry = {
    FAMILY: FAMILY, MODELS: MODELS, TASK_ROUTING: TASK_ROUTING,
    list() { return Object.keys(MODELS).map((k) => MODELS[k]); },
    get(key) { return MODELS[key] || null; },
    keys() { return Object.keys(MODELS); },
    tasks() { return Object.keys(TASK_ROUTING); },
    modelForTask(task) { return TASK_ROUTING[task] || null; },
    taskAllowed(key, task) { const m = MODELS[key]; return !!(m && task && m.allowedTasks.indexOf(task) !== -1); },

    /** Documented candidate id(s) for the configured runtime — UNVERIFIED.
     *  The owner confirms the operative id when activating the governed artifact. */
    providerCandidates(key) {
      const m = MODELS[key]; if (!m) return null;
      const runtime = String(flag('modelRuntime', 'nim'));
      const ckeys = Object.keys(m.candidates || {});
      const modelId = m.candidates[runtime] || m.candidates.nim || m.candidates.huggingface || (ckeys.length ? m.candidates[ckeys[0]] : null);
      const note = m.provider === 'private_gpu' ? 'Set the served model name on your GPU server, then confirm it here before activation.' : 'Confirm this id in the provider catalog (NVIDIA NIM / Hugging Face) before activation.';
      return { runtime: m.provider === 'private_gpu' ? 'private_gpu' : runtime, modelId: modelId, verified: false, note: note, all: m.candidates };
    },

    /** Risk score for a (model, task) pair from its tier + task sensitivity. */
    riskScoreFor(key, task) {
      const m = MODELS[key];
      const base = ({ low: 20, medium: 45, high: 70 })[m ? m.riskTier : 'medium'] || 45;
      const bump = task === 'draft_customer_message' ? 15 : 0;
      return Math.min(100, base + bump);
    }
  };

  global.AAA_MODEL_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
