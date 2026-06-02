/*
 * AAA Model Router — task-aware Claude model selection.
 *
 * The agent registry assigns each agent a static model (workers → Sonnet,
 * CEO/Supervisor → Opus). That captures ROLE but not the cost shape of a given
 * TASK: classifying a lead, tagging a note, or summarizing a transcript does
 * not need a worker-grade model, and a hard migration/security review deserves
 * the top model regardless of who asked.
 *
 * This router adds the missing Haiku tier and routes by task kind:
 *   - Opus   → planning, synthesis, security review, migration, high-stakes
 *   - Sonnet → coding, execution, refactor, review (the default executor)
 *   - Haiku  → triage, classification, tagging, summarization, routing
 *
 * It is pure and config-free. `route(kind)` is the source of truth; `forAgent`
 * is backward-compatible: with no/unknown task kind it returns the agent's
 * declared model unchanged (so existing meetings/synthesis keep using Opus and
 * workers keep using Sonnet), and only routes when a caller names a task kind.
 * `effort`/`tier`/pricing are advisory metadata for logging and cost control —
 * the router never sends unverified params to the proxy.
 */
;(function (global) {
  'use strict';

  const MODELS = {
    OPUS: 'claude-opus-4-8',
    SONNET: 'claude-sonnet-4-6',
    HAIKU: 'claude-haiku-4-5'
  };

  // Capability rank (low → high) and public $/MTok (input, output) for cost notes.
  const RANK = { 'claude-haiku-4-5': 1, 'claude-sonnet-4-6': 2, 'claude-opus-4-8': 3 };
  const PRICE = {
    'claude-haiku-4-5': { in: 1, out: 5, tier: 'economy' },
    'claude-sonnet-4-6': { in: 3, out: 15, tier: 'standard' },
    'claude-opus-4-8': { in: 5, out: 25, tier: 'premium' }
  };

  // Task kind → model. Keys are normalized (lowercase, non-alnum → _).
  const KIND_MODEL = {
    planning: MODELS.OPUS,
    synthesis: MODELS.OPUS,
    security_review: MODELS.OPUS,
    migration: MODELS.OPUS,
    architecture: MODELS.OPUS,
    high_stakes: MODELS.OPUS,

    coding: MODELS.SONNET,
    execution: MODELS.SONNET,
    refactor: MODELS.SONNET,
    review: MODELS.SONNET,
    analysis: MODELS.SONNET,
    default: MODELS.SONNET,

    triage: MODELS.HAIKU,
    classification: MODELS.HAIKU,
    tagging: MODELS.HAIKU,
    summarization: MODELS.HAIKU,
    routing: MODELS.HAIKU,
    extraction: MODELS.HAIKU
  };

  // Adaptive-thinking effort hint per model (advisory; not sent to the proxy
  // unless a caller opts in). Opus on coding/high-autonomy wants the most.
  function effortFor(model) {
    if (model === MODELS.OPUS) return 'xhigh';
    if (model === MODELS.SONNET) return 'medium';
    return 'low';
  }

  function normalizeKind(kind) {
    return String(kind == null ? '' : kind).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function decorate(model, reason) {
    const p = PRICE[model] || {};
    return { model: model, tier: p.tier || 'standard', effort: effortFor(model), priceInPerMTok: p.in, priceOutPerMTok: p.out, reason: reason };
  }

  const Router = {
    MODELS: MODELS,

    /** Is this a model id the router knows how to rank/price? */
    isKnownModel(model) { return Object.prototype.hasOwnProperty.call(RANK, String(model)); },

    /** Route purely by task kind. Unknown kind → the default (Sonnet) executor. */
    route(kind) {
      const k = normalizeKind(kind);
      if (k && Object.prototype.hasOwnProperty.call(KIND_MODEL, k)) {
        return decorate(KIND_MODEL[k], 'task kind "' + k + '"');
      }
      return decorate(KIND_MODEL.default, k ? 'unknown task kind "' + k + '" → default executor' : 'no task kind → default executor');
    },

    /**
     * Backward-compatible routing for a registered agent.
     * @param {string} agentModel  the agent's declared model
     * @param {string} [kind]      optional task kind to route by
     * @returns {{model,tier,effort,reason,...}}
     */
    forAgent(agentModel, kind) {
      const k = normalizeKind(kind);
      if (k && Object.prototype.hasOwnProperty.call(KIND_MODEL, k)) {
        return this.route(k);
      }
      // No/unknown kind: preserve the agent's declared model (current behavior).
      const model = this.isKnownModel(agentModel) ? agentModel : KIND_MODEL.default;
      return decorate(model, 'agent default (' + model + ')');
    },

    /** Cheaper of two models (by capability rank); handy for budget caps. */
    cheaper(a, b) { return (RANK[a] || 99) <= (RANK[b] || 99) ? a : b; }
  };

  global.AAA_MODEL_ROUTER = Router;
})(typeof window !== 'undefined' ? window : this);
