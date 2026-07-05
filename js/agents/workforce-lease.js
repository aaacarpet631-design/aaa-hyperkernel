/*
 * AAA Workforce Lease — mutual exclusion for an at-least-once world.
 *
 * Once a real cron (or two, or a retry) drives the workforce, the same due
 * work WILL be picked up twice unless something says no. This module is the
 * something: named, TTL-bounded, owner-stamped leases persisted in the
 * shared datastore.
 *
 *   acquire(name, {owner, ttlMs})  → the lease, or LEASE_HELD with the
 *                                    holder and expiry named (never silent)
 *   renew(name, owner)             → extend your own lease; others refused
 *   release(name, owner)           → release your own lease; others refused
 *
 * Expired leases can be taken over — and every takeover is AUDITED, because
 * a takeover means a runner died mid-tick and someone should be able to see
 * that. Fail-closed: a live lease held by someone else is a refusal, not a
 * queue.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'workforce_leases';
  const DEFAULT_TTL_MS = 5 * 60e3;

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function leaseId(name) { return ws() + ':' + name; }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) await ledger().append(type, payload); } catch (_) { /* best-effort */ }
  }

  const Lease = {
    COLLECTION: COLLECTION,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,

    /** Take the named lease, or be refused with the live holder named. */
    acquire: async function (name, opts) {
      const o = opts || {};
      if (!name || !o.owner) return { ok: false, error: 'BAD_LEASE', reason: 'name and owner required' };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const id = leaseId(name);
      const existing = await data().get(COLLECTION, id);
      const at = now();
      if (existing && existing.owner !== o.owner && Date.parse(existing.expiresAt) > at) {
        return { ok: false, error: 'LEASE_HELD', name: name, holder: existing.owner, expiresAt: existing.expiresAt };
      }
      const takeover = !!(existing && existing.owner !== o.owner);
      const rec = {
        id: id, workspaceId: ws(), name: name, owner: o.owner,
        acquiredAt: nowISO(),
        expiresAt: new Date(at + (isFinite(+o.ttlMs) && +o.ttlMs > 0 ? +o.ttlMs : DEFAULT_TTL_MS)).toISOString(),
        takeovers: (existing && existing.takeovers) || 0
      };
      if (takeover) {
        rec.takeovers += 1;
        await audit('workforce.lease.takeover', { name: name, from: existing.owner, to: o.owner, expiredAt: existing.expiresAt });
      }
      await data().put(COLLECTION, id, rec);
      return { ok: true, lease: rec, takeover: takeover };
    },

    /** Extend your own live lease. */
    renew: async function (name, owner, ttlMs) {
      const rec = data() ? await data().get(COLLECTION, leaseId(name)) : null;
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      if (rec.owner !== owner) return { ok: false, error: 'NOT_OWNER', holder: rec.owner };
      rec.expiresAt = new Date(now() + (isFinite(+ttlMs) && +ttlMs > 0 ? +ttlMs : DEFAULT_TTL_MS)).toISOString();
      await data().put(COLLECTION, rec.id, rec);
      return { ok: true, lease: rec };
    },

    /** Release your own lease; releasing someone else's is refused. */
    release: async function (name, owner) {
      const rec = data() ? await data().get(COLLECTION, leaseId(name)) : null;
      if (!rec) return { ok: true, note: 'no lease to release' };
      if (rec.owner !== owner) return { ok: false, error: 'NOT_OWNER', holder: rec.owner };
      rec.expiresAt = nowISO(); // expire immediately (record kept for takeover history)
      await data().put(COLLECTION, rec.id, rec);
      return { ok: true };
    },

    /** Inspect a lease (owner, expiry, takeover count). */
    get: async function (name) {
      return data() ? data().get(COLLECTION, leaseId(name)) : null;
    }
  };

  global.AAA_WORKFORCE_LEASE = Lease;
})(typeof window !== 'undefined' ? window : this);
