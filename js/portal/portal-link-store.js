/*
 * AAA Portal Links — owner-side: create/revoke a shareable link a customer can
 * open (no login) to view their quote/contract, sign it, and see the invoice.
 *
 * A link is an unguessable token mapped to ONE contract. The record carries
 * only references (contractId/jobId/customerId/workspaceId) + lifecycle
 * (expiresAt, revoked, allowSign) — never financial internals. The public
 * portal page never touches Firestore directly; it calls the portalProxy Cloud
 * Function, which resolves the token server-side and returns a REDACTED view.
 *
 * Local-first + cloud-mirrored like the other stores. The link only works
 * end-to-end once Firestore + the portalProxy function are configured (the
 * function needs server-side read access); the token/redaction logic itself is
 * pure and unit-tested.
 */
;(function (global) {
  'use strict';

  const LINKS = 'portal_links';
  const DAY = 86400000;

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }

  // Cryptographically-random, URL-safe token (unguessable; ~150 bits).
  function makeToken() {
    const bytes = new Uint8Array(24);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  const Store = {
    COLLECTION: LINKS,

    async list() { return (await data().list(LINKS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async forContract(contractId) { return (await this.list()).filter((l) => l.contractId === contractId); },
    async get(token) { const r = await data().get(LINKS, token); return mine(r) ? r : null; },

    /**
     * Create a share link for a contract.
     * @param {Object} contract  the AAA contract record
     * @param {{expiresInDays?:number, allowSign?:boolean}} [opts]
     */
    async create(contract, opts) {
      if (!contract || !contract.id) return { ok: false, error: 'NO_CONTRACT' };
      const o = opts || {};
      const token = makeToken();
      const days = o.expiresInDays != null ? Number(o.expiresInDays) : 30;
      // 0 (or null) means "never expires"; any other finite value sets a date —
      // positive in the future, negative already in the past (i.e. dead).
      const hasExpiry = isFinite(days) && days !== 0;
      const rec = {
        id: token,                       // the token IS the doc id
        contractId: contract.id,
        jobId: contract.jobId || null,
        customerId: contract.customerId || null,
        customerName: contract.customerName || 'Customer',
        allowSign: o.allowSign !== false,
        revoked: false,
        workspaceId: ws(),
        createdAt: nowISO(),
        expiresAt: hasExpiry ? new Date(Date.now() + days * DAY).toISOString() : null
      };
      await put(rec);
      return { ok: true, link: rec, url: this.urlFor(token) };
    },

    async revoke(token) {
      const r = await this.get(token);
      if (!r) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, r, { revoked: true, updatedAt: nowISO() });
      await put(rec);
      return { ok: true };
    },

    /** Public URL a customer opens. Base is configurable; defaults to origin. */
    urlFor(token) {
      let base = flag('portalBaseUrl', null);
      if (!base && typeof global.location !== 'undefined') base = global.location.origin;
      base = (base || '').replace(/\/$/, '');
      return base + '/portal.html?t=' + encodeURIComponent(token);
    },

    isLive(link) {
      if (!link || link.revoked) return false;
      if (link.expiresAt && Date.parse(link.expiresAt) < Date.now()) return false;
      return true;
    }
  };

  async function put(rec) {
    await data().put(LINKS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(LINKS, rec.id, rec); } catch (_) {}
  }

  global.AAA_PORTAL_LINKS = Store;
})(typeof window !== 'undefined' ? window : this);
