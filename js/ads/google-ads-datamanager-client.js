/*
 * AAA Google Ads Data Manager Adapter — the contract-first bridge between
 * HyperKernel's human-released conversion export batches and the SHAPE of the
 * Google Data Manager API's ingestEvents request. Shape only: this module has
 * NO transport, NO credentials handling, and NEVER touches the network.
 *
 * Position in the pipeline (each step separately governed):
 *
 *   ad-attribution.js  → which click produced the lead
 *   ads-conversion-ledger.js → deduped conversion events; uploadQueue() emits
 *     payloads only for click-id'd + consent-granted leads; releaseExport()
 *     (gateway action EXPORT_CONVERSIONS, aiAllowed:false) writes the human-
 *     approved batch to 'ads_conversion_exports' with status 'released'.
 *   THIS MODULE        → maps a RELEASED batch's payloads into Data-Manager-
 *     shaped request objects and records dry-run fixtures. Nothing more.
 *
 * Hard rules, enforced by code and proven by tests:
 *  - RELEASED BATCHES ONLY: the adapter consumes 'ads_conversion_exports'
 *    records with status 'released'. Anything else → {ok:false, error:'NOT_RELEASED'}.
 *  - VALIDATE, NEVER DROP: a payload must carry exactly one click id
 *    (gclid | gbraid | wbraid), a conversionTime, and an orderId. Invalid
 *    payloads land in rejected[] with explicit reasons — never silently lost.
 *  - CASE-SENSITIVE CLICK IDS: gclid/gbraid/wbraid are opaque, case-sensitive
 *    tokens. They pass through VERBATIM — never lowercased, trimmed, or
 *    otherwise normalized.
 *  - NO FAKE SUCCESS: there is no real transport in this codebase. Any
 *    real-send path returns {ok:false, error:'TRANSPORT_NOT_IMPLEMENTED'}
 *    even when a credentials flag is set. dryRun() writes a fixture record
 *    honestly labeled mode:'fixture' and NEVER flips batch.transmitted —
 *    that stays false until a real, owner-credentialed transport exists.
 *  - Deterministic, null-tolerant, zero dependencies.
 */
;(function (global) {
  'use strict';

  const EXPORTS_COLLECTION = 'ads_conversion_exports';
  const FIXTURES_COLLECTION = 'ads_transmission_fixtures';
  const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function flag(key, dflt) { return cfg().flag ? cfg().flag(key, dflt) : dflt; }

  /** Which click-id keys are present (non-empty) on a payload. */
  function presentClickIds(p) {
    return CLICK_ID_KEYS.filter(function (k) { return p[k] != null && p[k] !== ''; });
  }

  /**
   * Validate one released-batch payload and map it to a Data-Manager-shaped
   * request. Returns {ok:true, request} or {ok:false, reasons:[...]}.
   * Click ids pass through verbatim — never lowercased or normalized.
   */
  function mapPayload(p) {
    if (!p || typeof p !== 'object') return { ok: false, reasons: ['NOT_AN_OBJECT'] };
    const reasons = [];
    const clicks = presentClickIds(p);
    if (clicks.length === 0) reasons.push('NO_CLICK_ID');
    if (clicks.length > 1) reasons.push('MULTIPLE_CLICK_IDS');
    if (p.conversionTime == null || p.conversionTime === '') reasons.push('NO_CONVERSION_TIME');
    if (p.orderId == null || p.orderId === '') reasons.push('NO_ORDER_ID');
    if (reasons.length) return { ok: false, reasons: reasons };

    const adIdentifiers = {};
    adIdentifiers[clicks[0]] = p[clicks[0]]; // verbatim — case-sensitive token
    return {
      ok: true,
      request: {
        destination: 'GOOGLE_ADS',
        accountId: flag('googleAdsCustomerId', null),
        event: {
          transactionId: p.orderId,
          eventTimestamp: p.conversionTime,
          conversionAction: p.conversionAction != null ? p.conversionAction : null,
          value: p.conversionValueUSD != null ? p.conversionValueUSD : null,
          currency: 'USD',
          adIdentifiers: adIdentifiers
        }
      }
    };
  }

  /** Load a batch and refuse anything that is not a human-released export. */
  async function loadReleasedBatch(batchId) {
    if (!data() || !data().get) return { ok: false, error: 'NO_STORE' };
    if (!batchId) return { ok: false, error: 'NO_BATCH_ID' };
    let batch = null;
    try { batch = await data().get(EXPORTS_COLLECTION, String(batchId)); } catch (_) { batch = null; }
    if (!mine(batch)) return { ok: false, error: 'BATCH_NOT_FOUND' };
    if (batch.status !== 'released') return { ok: false, error: 'NOT_RELEASED', status: batch.status || null };
    return { ok: true, batch: batch };
  }

  const Adapter = {
    EXPORTS_COLLECTION: EXPORTS_COLLECTION,
    FIXTURES_COLLECTION: FIXTURES_COLLECTION,

    /**
     * Map a released batch's payloads to Data-Manager-shaped requests.
     * Only 'released' batches are consumable (NOT_RELEASED otherwise). Every
     * payload either becomes a request or an entry in rejected[] with reasons
     * — requests.length + rejected.length always equals payloads.length.
     */
    async prepareRequests(batchId) {
      const loaded = await loadReleasedBatch(batchId);
      if (!loaded.ok) return loaded;
      const payloads = Array.isArray(loaded.batch.payloads) ? loaded.batch.payloads : [];
      const requests = [], rejected = [];
      for (let i = 0; i < payloads.length; i++) {
        const mapped = mapPayload(payloads[i]);
        if (mapped.ok) requests.push(mapped.request);
        else rejected.push({
          index: i,
          orderId: payloads[i] && payloads[i].orderId != null ? payloads[i].orderId : null,
          reasons: mapped.reasons
        });
      }
      return { ok: true, batchId: loaded.batch.id, requests: requests, rejected: rejected };
    },

    /** True only when an owner has set the 'googleAdsCredentials' flag. */
    credentialsPresent() { return !!flag('googleAdsCredentials', null); },

    /**
     * The real-send path — deliberately NOT implemented. This codebase has no
     * transport to Google, so even with credentials present this returns
     * {ok:false, error:'TRANSPORT_NOT_IMPLEMENTED'}. It never fakes success
     * and never flips batch.transmitted. Use dryRun() for fixtures.
     */
    async send(batchId) {
      const loaded = await loadReleasedBatch(batchId);
      if (!loaded.ok) return loaded;
      if (!this.credentialsPresent()) return { ok: false, error: 'NO_CREDENTIALS', transmitted: false };
      // Credentials alone do not make a transport. Nothing here can transmit.
      return { ok: false, error: 'TRANSPORT_NOT_IMPLEMENTED', transmitted: false, credentialsPresent: true };
    },

    /**
     * Prepare requests for a released batch and persist ONE fixture record in
     * 'ads_transmission_fixtures', honestly labeled mode:'fixture'. Nothing is
     * transmitted and batch.transmitted is never touched — it stays false
     * until a real transport exists. Returns { ok, fixture }.
     */
    async dryRun(batchId, opts) {
      const o = opts || {};
      if (!data() || !data().put) return { ok: false, error: 'NO_STORE' };
      const prepared = await this.prepareRequests(batchId);
      if (!prepared.ok) return prepared;
      const fixture = {
        id: ids() && ids().createId ? ids().createId('adsfix') : 'adsfix_' + nowISO(),
        workspaceId: ws(),
        batchId: prepared.batchId,
        mode: 'fixture', // honest label: generated shapes, never sent
        requests: prepared.requests,
        rejected: prepared.rejected,
        note: o.note != null ? String(o.note).slice(0, 300) : null,
        createdAt: nowISO()
      };
      try { await data().put(FIXTURES_COLLECTION, fixture.id, fixture); } catch (_) { return { ok: false, error: 'WRITE_FAILED' }; }
      return { ok: true, fixture: fixture };
    },

    /** Fixtures recorded for this workspace (newest last, store order). */
    async listFixtures() {
      if (!data() || !data().list) return [];
      try { return ((await data().list(FIXTURES_COLLECTION)) || []).filter(mine); } catch (_) { return []; }
    },

    /** Honest health check. */
    async healthCheck() {
      if (!data()) return { ok: false, error: 'NO_STORE' };
      const fixtures = await this.listFixtures();
      return { ok: true, fixtures: fixtures.length, credentialsPresent: this.credentialsPresent(), transport: 'NOT_IMPLEMENTED' };
    }
  };

  global.AAA_ADS_DATAMANAGER = Adapter;
})(typeof window !== 'undefined' ? window : this);
