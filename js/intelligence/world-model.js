/*
 * AAA World Model — the governed, live model of reality the strategic layer
 * reasons over.
 *
 * It is the facade over the signal stack: derive (signal-derivation-engine),
 * store immutably (world-state-ledger), and project a freshness-protected
 * snapshot the Simulation Council can consume safely. The snapshot is the
 * integration surface: it returns only signals that are fresh or
 * adequately-degraded — stale/blocked/insufficient signals are reported but
 * never handed over as usable values, so a simulation can never be silently
 * driven by stale state.
 *
 * Read-only over the business; it writes only world-model collections.
 */
;(function (global) {
  'use strict';

  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_WORLD_STATE_LEDGER; }
  function sentinel() { return global.AAA_SIGNAL_FRESHNESS_SENTINEL; }
  function derivation() { return global.AAA_SIGNAL_DERIVATION_ENGINE; }
  function bus() { return global.AAA_EVENT_BUS; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach((k) => deepFreeze(o[k])); Object.freeze(o); } return o; }

  function defineContracts() {
    const b = bus();
    if (!b || b.contract('signal.recorded')) return;
    b.define('signal.recorded', { version: 1, description: 'A world-model signal was appended.', schema: { type: 'object', required: ['signalId'], properties: { signalId: { type: 'string' }, signalType: { type: 'string' } } } });
    b.define('causal.status_changed', { version: 1, description: 'A causal hypothesis changed status.', schema: { type: 'object', required: ['hypothesisId'], properties: { hypothesisId: { type: 'string' }, status: { type: 'string' } } } });
  }

  const WorldModel = {
    /** Refresh signals from current graph data. */
    async refresh(opts) { defineContracts(); return derivation() ? derivation().deriveAll(opts) : { ok: false, error: 'NO_DERIVATION_ENGINE' }; },

    /** Record a signal directly (e.g. an external/manual observation). */
    async observe(signal) { defineContracts(); return ledger().append(signal); },

    /** Full read model: every registered type with its current assessment. */
    async readModel(now, opts) { return ledger().deriveCurrentReadModel(now != null ? now : nowMs(), opts); },

    /**
     * Immutable snapshot for the Simulation Council. Splits signals into
     * `usable` (fresh / adequately-degraded ≥ minConfidence) and `withheld`
     * (blocked / insufficient / too-degraded) — so the consumer literally
     * cannot read a stale value. Frozen.
     */
    async snapshot(opts) {
      const o = opts || {};
      defineContracts();
      const ref = o.now != null ? o.now : nowMs();
      const model = await ledger().deriveCurrentReadModel(ref, o);
      const usable = {}; const withheld = {};
      Object.keys(model).forEach((type) => {
        const a = model[type];
        if (sentinel().usableForSimulation(a, o.minConfidence)) usable[type] = { value: a.value, confidence: a.confidence, status: a.status };
        else withheld[type] = { status: a.status, confidence: a.confidence || 0 };
      });
      return deepFreeze({ at: nowISO(), minConfidence: o.minConfidence == null ? 0.2 : o.minConfidence, usable: usable, withheld: withheld });
    },

    /** One signal's current assessment. */
    async signal(type, now, opts) { const m = await ledger().deriveCurrentReadModel(now != null ? now : nowMs(), opts); return m[type] || { status: 'insufficient_data', value: null, confidence: 0 }; },

    install() { defineContracts(); return { ok: !!bus() }; }
  };

  global.AAA_WORLD_MODEL = WorldModel;
})(typeof window !== 'undefined' ? window : this);
