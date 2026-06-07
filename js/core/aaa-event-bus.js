/*
 * AAA Event Bus — typed, contract-validated domain events over the in-app bus.
 *
 * The transferable idea from event-driven architectures (NATS/DSX, AsyncAPI),
 * realized natively with ZERO infrastructure: no broker, no network, no runtime
 * dependency, fully offline-safe. AAA HyperKernel owns the contracts and the log.
 *
 * Each domain event has a CONTRACT (type + version + payload schema). publish():
 *   1. validates the payload against the contract (rejects drift — no fake
 *      success: an invalid payload is NOT logged and NOT delivered),
 *   2. appends an IMMUTABLE, hash-chained record to the owner-only event_log
 *      (seq + prevHash + hash → tamper-evident, like the audit chain),
 *   3. delivers to in-app subscribers via the existing AAA_EVENTS bus.
 *
 * A small bridge mirrors selected existing AAA_EVENTS topics into the typed log,
 * so real activity (e.g. inbound customer messages) is captured without editing
 * the emitters. Null-tolerant; deterministic (no randomness in validation/chain).
 */
;(function (global) {
  'use strict';

  const LOG = 'event_log';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function events() { return global.AAA_EVENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  // Deterministic content hash for the event chain (cyrb53 → 14 hex chars).
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ('0000000000000' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)).slice(-14);
  }
  function canonical(v) {
    if (v == null) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  function chainHash(rec, prevHash) { return cyrb53(rec.type + '|' + rec.version + '|' + rec.seq + '|' + canonical(rec.payload) + '|' + (prevHash || ''), 0x5eed); }

  // ---- minimal, deterministic schema validator (AsyncAPI-ish, one level) ----
  function typeOf(v) { return Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v); }
  function validate(payload, schema) {
    const issues = [];
    const s = schema || {};
    if (s.type && s.type !== 'object') { if (typeOf(payload) !== s.type) issues.push('payload must be ' + s.type); return { ok: issues.length === 0, issues: issues }; }
    const p = payload || {};
    if (typeOf(payload) !== 'object') { return { ok: false, issues: ['payload must be an object'] }; }
    (s.required || []).forEach((k) => { if (p[k] === undefined || p[k] === null) issues.push('missing required: ' + k); });
    const props = s.properties || {};
    Object.keys(props).forEach((k) => {
      if (p[k] === undefined || p[k] === null) return;
      const spec = props[k];
      if (spec.type && typeOf(p[k]) !== spec.type) issues.push(k + ' must be ' + spec.type);
      if (spec.enum && spec.enum.indexOf(p[k]) === -1) issues.push(k + ' must be one of ' + spec.enum.join('/'));
    });
    if (s.additionalProperties === false) Object.keys(p).forEach((k) => { if (!props[k]) issues.push('unexpected field: ' + k); });
    return { ok: issues.length === 0, issues: issues };
  }

  const CONTRACTS = {};   // type -> { type, version, description, schema, bridged }
  let TRANSPORT = null;   // optional external forwarder (dumb pipe); default in-app only

  function define(type, def) {
    const d = def || {};
    CONTRACTS[type] = { type: type, version: d.version || 1, description: d.description || '', schema: d.schema || { type: 'object' }, bridged: !!d.bridged };
    return CONTRACTS[type];
  }

  // ---- seed contracts: a few high-value AAA domain events -------------------
  // Explicit-publish domain events:
  define('quote.created', { version: 1, description: 'A quote/estimate was created.', schema: { type: 'object', required: ['quoteId'], properties: { quoteId: { type: 'string' }, customerId: { type: 'string' }, total: { type: 'number' } } } });
  define('quote.sent', { version: 1, description: 'A quote was sent to a customer.', schema: { type: 'object', required: ['quoteId'], properties: { quoteId: { type: 'string' }, channel: { type: 'string', enum: ['sms', 'email'] } } } });
  define('job.closed', { version: 1, description: 'A job was closed/completed.', schema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, outcome: { type: 'string' } } } });
  define('recommendation.created', { version: 1, description: 'An AI recommendation was produced.', schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, agent: { type: 'string' }, confidence: { type: 'number' } } } });
  // Bridged events (mirrored from existing AAA_EVENTS emits — low frequency, domain-meaningful):
  define('comm.inbound', { version: 1, description: 'An inbound customer message arrived.', bridged: true, schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, threadId: { type: 'string' } } } });
  define('comm.notification', { version: 1, description: 'An owner notification was raised.', bridged: true, schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, kind: { type: 'string' } } } });

  const Bus = {
    LOG: LOG,
    /** Register/replace an event contract. */
    define: define,
    /** All registered contracts (the catalog). */
    contracts() { return Object.keys(CONTRACTS).map((k) => CONTRACTS[k]); },
    contract(type) { return CONTRACTS[type] || null; },

    /**
     * Publish a typed domain event: validate → append to the immutable log →
     * deliver to subscribers. Rejects unknown types and schema-invalid payloads
     * (no drift, no fake success). @returns {ok, event} | {ok:false, error, issues}
     */
    async publish(type, payload, opts) {
      const o = opts || {};
      const c = CONTRACTS[type];
      if (!c) return { ok: false, error: 'UNKNOWN_EVENT_TYPE' };
      const v = validate(payload, c.schema);
      if (!v.ok) {
        // Record the rejection (audit of drift) but NOT as a valid event.
        if (events()) events().emit('eventbus.rejected', { type: type, issues: v.issues });
        return { ok: false, error: 'SCHEMA_INVALID', issues: v.issues };
      }
      const prev = await this._last();
      const seq = (prev ? prev.seq : 0) + 1;
      const rec = {
        id: newId('evt'), workspaceId: ws(), type: type, version: c.version,
        payload: payload || {}, source: o.source || 'app', actor: o.actor || null,
        seq: seq, prevHash: prev ? prev.hash : null, hash: null, at: nowISO()
      };
      rec.hash = chainHash(rec, rec.prevHash);
      await put(rec);
      if (events()) events().emit('event.' + type, rec);   // typed delivery to in-app subscribers
      // Optional external transport (NATS/MQTT/Kafka/etc.) as a DUMB PIPE — the
      // app owns the contract, log, and chain; a transport only FORWARDS. Default
      // none (in-app only). Best-effort: a transport failure never breaks publish
      // and never corrupts the local log (offline-safe).
      if (TRANSPORT && typeof TRANSPORT.publish === 'function') {
        try { const r = TRANSPORT.publish(type, rec); if (r && typeof r.then === 'function') r.catch(function () {}); } catch (_) {}
      }
      return { ok: true, event: rec };
    },

    /** Plug in an external transport adapter { name, publish(type, event) } that
     *  forwards published events to a broker. Provider-neutral; pass null to
     *  detach. The local contract/log/chain are unaffected either way. */
    setTransport(adapter) { TRANSPORT = (adapter && typeof adapter.publish === 'function') ? adapter : null; return { ok: true, transport: TRANSPORT ? TRANSPORT.name || 'custom' : null }; },
    transport() { return TRANSPORT ? (TRANSPORT.name || 'custom') : null; },

    /**
     * Export the contract catalog as an AsyncAPI 2.6 document (the portable,
     * infra-free artifact). Deterministic (sorted channels) so it can be diffed
     * and kept in sync with schemas/asyncapi/. No toolchain required.
     */
    asyncapi(opts) {
      const o = opts || {};
      const channels = {};
      Object.keys(CONTRACTS).sort().forEach((type) => {
        const c = CONTRACTS[type];
        channels[type] = {
          description: c.description || '',
          subscribe: { operationId: 'on_' + type.replace(/[^a-z0-9]+/gi, '_'), message: { name: type, contentType: 'application/json', 'x-version': c.version, 'x-bridged': !!c.bridged, payload: c.schema || { type: 'object' } } }
        };
      });
      return {
        asyncapi: '2.6.0',
        info: { title: o.title || 'AAA HyperKernel Events', version: o.version || '1.0.0', description: 'Native, contract-validated domain events. App-owned; transport-neutral; offline-safe.' },
        defaultContentType: 'application/json',
        channels: channels
      };
    },

    /** Subscribe to a typed event. Returns an unsubscribe function. */
    subscribe(type, handler) {
      if (!events()) return function () {};
      return events().on('event.' + type, (rec) => handler(rec && rec.payload, rec));
    },

    /** Read the event log (newest first), optionally filtered by type. */
    async log(filter) {
      const f = filter || {};
      let all = (await data().list(LOG)).filter(mine);
      if (f.type) all = all.filter((e) => e.type === f.type);
      return all.sort((a, b) => (b.seq || 0) - (a.seq || 0));
    },
    async get(id) { const r = await data().get(LOG, id); return mine(r) ? r : null; },

    /** Recompute the event chain and report any tamper/gap. */
    async verifyChain() {
      const all = (await data().list(LOG)).filter(mine).sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const breaks = []; let prevHash = null;
      all.forEach((e, i) => {
        if (i > 0 && e.seq !== all[i - 1].seq + 1) breaks.push({ seq: e.seq, id: e.id, reason: 'seq_gap' });
        if ((e.prevHash || null) !== (prevHash || null)) breaks.push({ seq: e.seq, id: e.id, reason: 'chain_break' });
        if (chainHash(e, e.prevHash) !== e.hash) breaks.push({ seq: e.seq, id: e.id, reason: 'hash_mismatch' });
        prevHash = e.hash;
      });
      return { ok: breaks.length === 0, length: all.length, breaks: breaks };
    },

    /** Communication/throughput analytics over the log. */
    async analytics() {
      const all = (await data().list(LOG)).filter(mine);
      const byType = {}; all.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });
      return { ok: true, total: all.length, byType: byType, contracts: this.contracts().length };
    },

    /**
     * Bridge existing AAA_EVENTS topics into the typed log (idempotent install).
     * Only contracts flagged bridged are wired; each mirror is best-effort and
     * contract-validated — invalid mirrors are dropped, never thrown.
     */
    bridge() {
      if (this._bridged || !events()) return { ok: true, wired: 0 };
      let wired = 0;
      this.contracts().filter((c) => c.bridged).forEach((c) => {
        events().on(c.type, (payload) => { this.publish(c.type, payload || {}, { source: 'bridge' }).catch(function () {}); });
        wired++;
      });
      this._bridged = true;
      return { ok: true, wired: wired };
    },

    // ---- internals ----
    _validate: validate,
    async _last() {
      const all = (await data().list(LOG)).filter(mine);
      return all.sort((a, b) => (b.seq || 0) - (a.seq || 0))[0] || null;
    }
  };

  async function put(rec) {
    await data().put(LOG, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(LOG, rec.id, rec); } catch (_) {}
  }

  // Auto-wire the bridge for real app activity (no-op under unit tests that
  // don't load AAA_EVENTS or AAA_DATA writes).
  try { Bus.bridge(); } catch (_) {}

  global.AAA_EVENT_BUS = Bus;
})(typeof window !== 'undefined' ? window : this);
