/*
 * AAA Google Ads Mock Client — a deterministic, fixture-driven FAKE of the
 * future Data Manager transport, for tests and demos ONLY.
 *
 * THIS IS A MOCK. It NEVER touches the network, never sees credentials, and
 * must NEVER be wired into a production path — it exists so tests can exercise
 * "what would the transport say?" against Data-Manager-shaped requests
 * (see js/ads/google-ads-datamanager-client.js) without any transport existing.
 *
 * Guarantees:
 *  - DETERMINISTIC: results are derived purely from request content. No
 *    randomness, no Date.now(), no clocks, no external state. The same input
 *    always produces byte-identical output.
 *  - HONEST SHAPE VALIDATION: malformed requests are rejected per-request
 *    with an explicit reason — never silently accepted or dropped.
 *  - CLEARLY LABELED: every response carries mode:'mock' and every synthetic
 *    receipt id is prefixed 'mockrcpt_' so nothing downstream can mistake a
 *    mock acceptance for a real Google acknowledgment.
 */
;(function (global) {
  'use strict';

  const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'];

  /** JSON.stringify with sorted object keys, so hashing ignores key order. */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(v[k]);
    }).join(',') + '}';
  }

  /** djb2 — tiny deterministic string hash; content-seeded receipt ids. */
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** Validate one Data-Manager-shaped request. Returns null or a reason code. */
  function shapeError(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'NOT_AN_OBJECT';
    if (r.destination !== 'GOOGLE_ADS') return 'BAD_DESTINATION';
    const e = r.event;
    if (!e || typeof e !== 'object') return 'NO_EVENT';
    if (e.transactionId == null || e.transactionId === '') return 'NO_TRANSACTION_ID';
    if (e.eventTimestamp == null || e.eventTimestamp === '') return 'NO_EVENT_TIMESTAMP';
    const ad = e.adIdentifiers;
    if (!ad || typeof ad !== 'object') return 'NO_AD_IDENTIFIERS';
    const present = CLICK_ID_KEYS.filter(function (k) { return ad[k] != null && ad[k] !== ''; });
    if (present.length === 0) return 'NO_CLICK_ID';
    if (present.length > 1) return 'MULTIPLE_CLICK_IDS';
    return null;
  }

  const Mock = {
    /** Always true and always labeled: this client is a mock, full stop. */
    isMock: true,

    /**
     * Pretend-ingest an array of Data-Manager-shaped requests. Returns
     * { ok, mode:'mock', results, accepted, rejected } with one result per
     * request in input order: { index, transactionId, status, reason?,
     * receiptId? }. receiptId is a content hash — same request, same receipt.
     * Nothing is transmitted anywhere; this is a synthetic response only.
     */
    accept(requests) {
      if (!Array.isArray(requests)) return { ok: false, error: 'REQUESTS_MUST_BE_ARRAY', mode: 'mock' };
      const results = [];
      let accepted = 0, rejected = 0;
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        const err = shapeError(r);
        const txn = r && r.event && r.event.transactionId != null ? r.event.transactionId : null;
        if (err) {
          rejected++;
          results.push({ index: i, transactionId: txn, status: 'rejected', reason: err });
        } else {
          accepted++;
          results.push({ index: i, transactionId: txn, status: 'accepted', receiptId: 'mockrcpt_' + hash(stableStringify(r)) });
        }
      }
      return { ok: true, mode: 'mock', results: results, accepted: accepted, rejected: rejected };
    }
  };

  global.AAA_ADS_MOCK_CLIENT = Mock;
})(typeof window !== 'undefined' ? window : this);
