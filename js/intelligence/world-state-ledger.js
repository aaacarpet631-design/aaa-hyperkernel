/*
 * AAA World State Ledger — append-only timeline of world-model signals.
 *
 * Signals are never rewritten. Each append is a new, deep-frozen record on the
 * timeline (collection world_signals); the "current state" is a READ MODEL
 * projected from the latest record per signal type, with the Freshness Sentinel
 * applied so stale signals can never silently present as fresh. This mirrors the
 * audit/capability/simulation ledgers: history is immutable, state is derived.
 *
 * Every record carries the full signal schema: signalId, signalType, value,
 * unit, source, confidence, volatility, observedAt, expiresAt, stalePolicy,
 * derivationMethod, relatedEntities, provenanceId.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'world_signals';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function registry() { return global.AAA_SIGNAL_REGISTRY; }
  function sentinel() { return global.AAA_SIGNAL_FRESHNESS_SENTINEL; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function clamp01(x) { const n = Number(x); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach((k) => deepFreeze(o[k])); Object.freeze(o); } return o; }
  function toISO(v) { if (v == null) return nowISO(); const t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? new Date(t).toISOString() : nowISO(); }

  const Ledger = {
    COLLECTION: COLLECTION,

    /**
     * Append a signal. Validates the type against the registry (governance:
     * unregistered types are rejected, not silently logged), clamps confidence
     * /volatility, fills defaults from the registry spec, deep-freezes, and
     * persists. Returns the frozen record. Append-only — never updates.
     */
    async append(signal) {
      const s = signal || {};
      const reg = registry();
      if (!reg || !reg.has(s.signalType)) return { ok: false, error: 'UNREGISTERED_SIGNAL_TYPE', signalType: s.signalType };
      const spec = reg.spec(s.signalType);
      const observed = toISO(s.observedAt);
      const expires = s.expiresAt != null ? toISO(s.expiresAt) : new Date(Date.parse(observed) + (spec.ttlMs || 86400000)).toISOString();
      const rec = deepFreeze({
        signalId: s.signalId || newId('sig'),
        workspaceId: ws(),
        signalType: s.signalType,
        value: (s.value === null || s.value === undefined) ? null : Number(s.value),
        unit: s.unit || spec.unit || 'scalar',
        source: s.source || 'unknown',
        confidence: clamp01(s.confidence),
        volatility: clamp01(s.volatility != null ? s.volatility : spec.volatility),
        observedAt: observed,
        expiresAt: expires,
        stalePolicy: s.stalePolicy || spec.stalePolicy || 'degrade_confidence',
        derivationMethod: s.derivationMethod || 'direct_injection',
        relatedEntities: Array.isArray(s.relatedEntities) ? s.relatedEntities.slice() : [],
        provenanceId: s.provenanceId || newId('prov'),
        recordedAt: nowISO()
      });
      await data().put(COLLECTION, rec.signalId, rec);
      try { if (global.AAA_EVENT_BUS && global.AAA_EVENT_BUS.contract('signal.recorded')) await global.AAA_EVENT_BUS.publish('signal.recorded', { signalId: rec.signalId, signalType: rec.signalType }, { source: 'world_model' }); } catch (_) {}
      return { ok: true, signalId: rec.signalId, record: rec };
    },

    /** Raw append-only timeline (oldest first), optionally filtered by type. */
    async getRawLedger(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.signalType) all = all.filter((r) => r.signalType === f.signalType);
      return all.sort((a, b) => String(a.observedAt || '').localeCompare(String(b.observedAt || '')));
    },

    /** Latest record for a signal type (by observedAt). */
    async latest(signalType) {
      const all = await this.getRawLedger({ signalType: signalType });
      return all.length ? all[all.length - 1] : null;
    },

    /**
     * Current-state read model: for each registered type, the latest record
     * assessed by the Freshness Sentinel. → Map(type → {status,value,confidence,...}).
     */
    async deriveCurrentReadModel(now, opts) {
      const ref = now != null ? now : nowMs();
      const out = {};
      const types = registry() ? registry().TYPES : [];
      for (const type of types) {
        const latest = await this.latest(type);
        out[type] = latest ? sentinel().assess(latest, ref, opts) : { status: 'insufficient_data', value: null, confidence: 0 };
      }
      return out;
    }
  };

  global.AAA_WORLD_STATE_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
