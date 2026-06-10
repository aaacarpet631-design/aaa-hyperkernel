/*
 * AAA Goal–Capability Bridge — the first true self-assembling loop.
 *
 * Closes the gap between "I know what I want" (Teleological Goal Engine) and
 * "I can build the capability required" (Genesis Foundry), without a human
 * hand-creating another council:
 *
 *   Goal → largest unmet delta → required capability
 *        → Capability Registry check
 *        → (gap) CAPABILITY_GAP_DETECTED
 *        → Genesis Council spawns an ephemeral agent
 *        → Tool Forge arms it → execution → Decision Log + graph facts
 *        → Capability Economy (ledger → reputation → promotion)
 *        → (after promotion) the gap is permanently closed
 *
 * This is pure COUPLING — it reuses the existing gap detector, agent factory,
 * spawn policy, runtime, and capability economy end to end (no duplication).
 * It mutates no production state: spawns run in the governed Genesis sandbox,
 * high-risk spawns are held, and a closed gap is a promoted capability, not a
 * silent code change.
 */
;(function (global) {
  'use strict';

  function bus() { return global.AAA_EVENT_BUS; }
  function goalEngine() { return global.AAA_TELEOLOGICAL_GOAL_ENGINE; }
  function registry() { return global.AAA_CAPABILITY_REGISTRY; }
  function council() { return global.AAA_GENESIS_COUNCIL; }
  function detector() { return global.AAA_GAP_DETECTOR; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  async function emit(type, payload) { try { if (bus() && bus().contract(type)) await bus().publish(type, payload, { source: 'goal_capability_bridge' }); } catch (_) {} }

  // Goal dimension → the capability that most directly moves it. Each maps to a
  // Genesis-spliceable need {action, entity, context, domain}. Dimensions whose
  // capability the company already employs resolve to no gap (handled).
  const DIMENSION_CAPABILITY = {
    grossMargin: { action: 'optimize', entity: 'quote', domain: 'finance' },
    closeRate: { action: 'analyze', entity: 'quote', domain: 'finance' },
    reviewVelocity: { action: 'generate', entity: 'review', domain: 'language' },
    crewUtilization: { action: 'schedule', entity: 'job', domain: 'operations' },
    customerSentiment: { action: 'detect', entity: 'sentiment', domain: 'language' },
    materialYield: { action: 'optimize', entity: 'material', domain: 'operations' },
    riskExposure: { action: 'audit', entity: 'risk', domain: 'legal' }
  };

  function defineContracts() {
    const b = bus();
    if (!b || b.contract('capability.gap_detected')) return;
    b.define('capability.gap_detected', { version: 1, description: 'A goal pursuit found no registered capability for a required action.', schema: { type: 'object', required: ['action', 'entity'], properties: { action: { type: 'string' }, entity: { type: 'string' }, context: { type: 'string' }, goalId: { type: 'string' } } } });
  }

  const Bridge = {
    DIMENSION_CAPABILITY: DIMENSION_CAPABILITY,

    /** Largest weighted unmet delta dimension of a goal vs current vector. */
    largestGap(goal, current) {
      const t = goal.targetVector, w = goal.weights || {};
      let best = null;
      Object.keys(t).forEach((dim) => {
        const cur = current[dim]; if (cur == null) return;
        const higherBetter = dim !== 'riskExposure';
        const shortfall = higherBetter ? (t[dim] - cur) : (cur - t[dim]);
        if (shortfall <= 0) return;
        // Normalize to a FRACTIONAL shortfall so dimensions on different scales
        // (0..1 ratios vs unbounded counts) are comparable before weighting.
        const denom = Math.abs(t[dim]) > 1e-9 ? Math.abs(t[dim]) : 1;
        const weighted = (shortfall / denom) * (w[dim] == null ? 1 : w[dim]);
        if (!best || weighted > best.weighted) best = { dimension: dim, shortfall: Math.round(shortfall * 1e4) / 1e4, weighted: Math.round(weighted * 1e6) / 1e6 };
      });
      return best;
    },

    /** Is the capability for a requirement already registered? → {gap, handler}. */
    async detectGap(requirement) {
      const r = requirement || {};
      if (!registry()) return { gap: true, requirement: r, handler: null };
      const handler = await registry().canHandle(r.action, r.entity, r.context);
      return { gap: !handler, handler: handler, requirement: r };
    },

    /**
     * Derive the required capability for a goal (from its largest unmet delta),
     * specialized by an optional context (e.g. 'commercial').
     */
    requirementFor(goal, current, context) {
      const gap = this.largestGap(goal, current);
      if (!gap) return null;
      const cap = DIMENSION_CAPABILITY[gap.dimension];
      if (!cap) return null;
      return Object.assign({}, cap, { context: context || gap.dimension, dimension: gap.dimension, weightedShortfall: gap.weighted });
    },

    /**
     * Pursue a capability requirement: if a registered capability handles it,
     * report that; otherwise emit CAPABILITY_GAP_DETECTED and route to the
     * Genesis Council, which spawns/executes/measures under governance.
     * opts.payload carries job context for the spawned agent.
     */
    async pursue(requirement, opts) {
      const o = opts || {};
      defineContracts();
      const r = requirement || {};
      if (!r.action || !r.entity) return { ok: false, error: 'INVALID_REQUIREMENT' };
      // Make the goal-driven need spliceable by the existing gap detector.
      if (detector() && detector().defineTrigger) detector().defineTrigger('goal.capability_gap', (p) => (p && p.need) || null);

      const det = await this.detectGap(r);
      if (!det.gap) return { ok: true, gap: false, handledBy: det.handler, requirement: r };

      await emit('capability.gap_detected', { action: r.action, entity: r.entity, context: r.context || null, goalId: o.goalId || null });
      if (!council()) return { ok: true, gap: true, spawned: false, error: 'GENESIS_UNAVAILABLE', requirement: r };

      const need = { action: r.action, entity: r.entity, context: r.context || 'general', domain: r.domain || null };
      const payload = Object.assign({ need: need }, o.payload || {});
      const result = await council().handleEvent('goal.capability_gap', payload, { councilApproved: !!o.councilApproved });
      return { ok: true, gap: true, requirement: r, genesis: result };
    },

    /**
     * One call from a goal: derive the requirement and pursue it. Returns the
     * full linkage (goal → dimension → requirement → genesis result).
     */
    async pursueGoal(goal, opts) {
      const o = opts || {};
      const current = (o.current && o.current.vector) || o.current || (goalEngine() ? (await goalEngine().currentVector(o.now != null ? o.now : nowMs())).vector : null);
      if (!current) return { ok: false, error: 'NO_CURRENT_VECTOR' };
      const req = this.requirementFor(goal, current, o.context);
      if (!req) return { ok: true, gap: false, note: 'goal already satisfied or no mapped capability' };
      const res = await this.pursue(req, o);
      return Object.assign({ dimension: req.dimension, requirement: req }, res);
    },

    install() { defineContracts(); if (detector() && detector().defineTrigger) detector().defineTrigger('goal.capability_gap', (p) => (p && p.need) || null); return { ok: !!bus() }; }
  };

  global.AAA_GOAL_CAPABILITY_BRIDGE = Bridge;
})(typeof window !== 'undefined' ? window : this);
