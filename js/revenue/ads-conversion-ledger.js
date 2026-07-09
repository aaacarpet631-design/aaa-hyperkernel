/*
 * AAA Ads Conversion Ledger — the conversion ladder between "a form was
 * filled" and "money hit the bank", recorded as first-class, deduplicated,
 * PII-free events keyed to the lead.
 *
 * The Ad Attribution ledger (ad-attribution.js) answers WHICH click produced a
 * lead; this module answers WHAT that lead was worth, step by step:
 *
 *   LEAD_CREATED → QUALIFIED_LEAD → ESTIMATE_SCHEDULED → ESTIMATE_SENT →
 *   JOB_WON → JOB_COMPLETED (→ HIGH_MARGIN_JOB), with BAD_LEAD / REFUND /
 *   COMPLAINT as negative learning signals.
 *
 * Hard rules, enforced by code and proven by tests:
 *  - DEDUPE: one event per (leadId, type). Recording JOB_WON twice is a no-op
 *    returning the original — uploads can never double-count.
 *  - RAW LEADS ARE NOT REVENUE: LEAD_CREATED is a volume signal
 *    (primarySignal:false, biddingEligible:false). Only JOB_WON /
 *    JOB_COMPLETED / HIGH_MARGIN_JOB are primary business signals.
 *  - PII-FREE BY WHITELIST: records are constructed from a fixed field set;
 *    a caller can pass a whole intake blob and no name/phone/email survives.
 *  - HIGH_MARGIN_JOB RULE: recordJobFinancials(leadId, {revenueUSD, costUSD})
 *    always records JOB_COMPLETED (valueUSD = revenue) and ALSO records
 *    HIGH_MARGIN_JOB (valueUSD = rounded margin, revenue - cost) when the
 *    margin percentage — (revenue - cost) / revenue * 100 — is at or above
 *    the 'adsHighMarginPctFloor' config flag (default 55). The raw cost
 *    breakdown is NEVER stored on any event; only the margin value survives.
 *  - UPLOAD IS GATED: uploadQueue() emits Google-ready payloads ONLY for
 *    events whose lead has a click id AND consent === 'granted'. Nothing here
 *    ever calls the Google Ads API — payload generation and transmission are
 *    separate, governed steps.
 *  - Deterministic, null-tolerant, no network, ids-only on the event bus.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'ads_conversion_events';

  // The conversion ladder. tier: what the event measures; direction: whether
  // it should push bidding up or down; primarySignal: business truth (won
  // work / revenue), the only tiers ROAS decisions may trust; biddingEligible:
  // whether the event may be offered to Google as an optimization target.
  const TYPES = {
    LEAD_CREATED:       { tier: 'volume',   direction: 'positive', primarySignal: false, biddingEligible: false },
    QUALIFIED_LEAD:     { tier: 'quality',  direction: 'positive', primarySignal: false, biddingEligible: true },
    ESTIMATE_SCHEDULED: { tier: 'quality',  direction: 'positive', primarySignal: false, biddingEligible: true },
    ESTIMATE_SENT:      { tier: 'intent',   direction: 'positive', primarySignal: false, biddingEligible: true },
    JOB_WON:            { tier: 'primary',  direction: 'positive', primarySignal: true,  biddingEligible: true },
    JOB_COMPLETED:      { tier: 'revenue',  direction: 'positive', primarySignal: true,  biddingEligible: true },
    HIGH_MARGIN_JOB:    { tier: 'premium',  direction: 'positive', primarySignal: true,  biddingEligible: true },
    BAD_LEAD:           { tier: 'negative', direction: 'negative', primarySignal: false, biddingEligible: false },
    REFUND:             { tier: 'negative', direction: 'negative', primarySignal: false, biddingEligible: false },
    COMPLAINT:          { tier: 'negative', direction: 'negative', primarySignal: false, biddingEligible: false }
  };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function attribution() { return global.AAA_AD_ATTRIBUTION; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function str(v, max) { return v == null ? null : String(v).slice(0, max || 200); }
  function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }

  const Ledger = {
    COLLECTION: COLLECTION,
    TYPES: Object.keys(TYPES),

    /** Metadata for one event type, or null. */
    typeInfo(type) { return TYPES[type] ? Object.assign({ type: type }, TYPES[type]) : null; },

    /** Only JOB_WON / JOB_COMPLETED / HIGH_MARGIN_JOB are business truth. */
    isPrimarySignal(type) { return !!(TYPES[type] && TYPES[type].primarySignal); },

    /**
     * Record one conversion event for a lead. Dedupe key is (leadId, type):
     * a repeat is a no-op returning the ORIGINAL event with deduped:true.
     * opts: { valueUSD?, sourceRef? (quoteId/jobId/invoiceId), note? }.
     * Constructed by whitelist — extra fields (names, phones) are dropped.
     */
    async record(leadId, type, opts) {
      if (!leadId) return { ok: false, error: 'NO_LEAD' };
      if (!TYPES[type]) return { ok: false, error: 'UNKNOWN_TYPE', type: String(type) };
      if (!data() || !data().put) return { ok: false, error: 'NO_STORE' };
      const o = opts || {};
      const id = String(leadId) + ':' + type;
      let prior = null;
      try { prior = await data().get(COLLECTION, id); } catch (_) { prior = null; }
      if (mine(prior)) return { ok: true, event: prior, deduped: true };

      const meta = TYPES[type];
      const ev = {
        id: id,
        workspaceId: ws(),
        leadId: String(leadId),
        type: type,
        tier: meta.tier,
        direction: meta.direction,
        primarySignal: meta.primarySignal,
        valueUSD: numOrNull(o.valueUSD),
        sourceRef: str(o.sourceRef, 80),
        note: str(o.note, 300),
        at: o.at || nowISO()
      };
      try { await data().put(COLLECTION, id, ev); } catch (_) { return { ok: false, error: 'WRITE_FAILED' }; }
      return { ok: true, event: ev, deduped: false };
    },

    /**
     * Record the financial outcome of a completed job in one step.
     * fin: { revenueUSD, costUSD, sourceRef? } — both numbers required and
     * finite, revenue > 0. Always records JOB_COMPLETED (valueUSD = revenue);
     * when marginPct = (revenue - cost) / revenue * 100 is at or above the
     * 'adsHighMarginPctFloor' flag (default 55) it ALSO records
     * HIGH_MARGIN_JOB with valueUSD = round(revenue - cost). The raw cost is
     * never stored — margin value only. Cost must be >= 0 (a negative cost
     * would fabricate margin beyond the job's revenue). FIRST WRITE WINS:
     * when JOB_COMPLETED dedupes, the repeat call's numbers are ignored —
     * no HIGH_MARGIN_JOB is derived from them and marginPct returns null
     * (the original cost was never stored, so it is honestly unknowable).
     * Returns { ok, events: [...], marginPct, highMargin, deduped? }.
     */
    async recordJobFinancials(leadId, fin) {
      if (!leadId) return { ok: false, error: 'NO_LEAD' };
      const f = fin || {};
      const revenue = Number(f.revenueUSD), cost = Number(f.costUSD);
      if (f.revenueUSD == null || !isFinite(revenue)) return { ok: false, error: 'REVENUE_REQUIRED' };
      if (f.costUSD == null || !isFinite(cost)) return { ok: false, error: 'COST_REQUIRED' };
      if (revenue <= 0) return { ok: false, error: 'REVENUE_MUST_BE_POSITIVE' };
      // A negative cost (sign/data-entry error) would fabricate a margin larger
      // than the job's revenue — refused the same way zero revenue is.
      if (cost < 0) return { ok: false, error: 'COST_MUST_BE_NON_NEGATIVE' };

      const completed = await this.record(leadId, 'JOB_COMPLETED', { valueUSD: revenue, sourceRef: f.sourceRef });
      if (!completed.ok) return completed;
      if (completed.deduped) {
        // First write wins — the ORIGINAL financials stand. Recomputing margin
        // from a repeat call's numbers could fabricate a HIGH_MARGIN_JOB the
        // recorded job never earned (the original cost is never stored, so the
        // true margin is unknowable here: marginPct is honestly null).
        let priorHM = null;
        try { priorHM = await data().get(COLLECTION, String(leadId) + ':HIGH_MARGIN_JOB'); } catch (_) { priorHM = null; }
        priorHM = mine(priorHM) ? priorHM : null;
        return { ok: true, deduped: true, events: priorHM ? [completed.event, priorHM] : [completed.event], marginPct: null, highMargin: !!priorHM };
      }
      const events = [completed.event];

      const marginPct = (revenue - cost) / revenue * 100;
      const floor = Number(cfg().flag ? cfg().flag('adsHighMarginPctFloor', 55) : 55);
      let highMargin = false;
      if (marginPct >= floor) {
        highMargin = true;
        // Margin value only — the raw cost breakdown is never persisted.
        const hm = await this.record(leadId, 'HIGH_MARGIN_JOB', { valueUSD: Math.round(revenue - cost), sourceRef: f.sourceRef });
        if (!hm.ok) return hm;
        events.push(hm.event);
      }
      return { ok: true, events: events, marginPct: marginPct, highMargin: highMargin };
    },

    async listForLead(leadId) {
      if (!data()) return [];
      try {
        return ((await data().list(COLLECTION)) || []).filter(mine)
          .filter(function (e) { return e.leadId === String(leadId); });
      } catch (_) { return []; }
    },

    /** All events, optionally filtered by { type?, direction?, primaryOnly? }. */
    async list(filter) {
      if (!data()) return [];
      const f = filter || {};
      try {
        return ((await data().list(COLLECTION)) || []).filter(mine).filter(function (e) {
          if (f.type && e.type !== f.type) return false;
          if (f.direction && e.direction !== f.direction) return false;
          if (f.primaryOnly && !e.primarySignal) return false;
          return true;
        });
      } catch (_) { return []; }
    },

    /**
     * Google-ready offline-conversion payloads for bidding-eligible events —
     * GENERATED, never transmitted. An event qualifies only when its lead's
     * attribution has (a) a click id and (b) consent === 'granted'. Everything
     * else is reported in `skipped` with the reason, so the measurement gap is
     * visible instead of silent.
     */
    async uploadQueue(opts) {
      const o = opts || {};
      const attr = attribution();
      const events = (await this.list(o.filter)).filter(function (e) {
        return TYPES[e.type] && TYPES[e.type].biddingEligible && (!o.type || e.type === o.type);
      });
      const payloads = [], skipped = [];
      for (const e of events) {
        const a = attr && attr.get ? await attr.get(e.leadId) : null;
        if (!a) { skipped.push({ eventId: e.id, reason: 'NO_ATTRIBUTION' }); continue; }
        if (!a.gclid && !a.gbraid && !a.wbraid) { skipped.push({ eventId: e.id, reason: 'NO_CLICK_ID' }); continue; }
        if (a.consent !== 'granted') { skipped.push({ eventId: e.id, reason: 'NO_CONSENT' }); continue; }
        payloads.push({
          eventId: e.id,
          conversionAction: e.type,
          gclid: a.gclid || null, gbraid: a.gbraid || null, wbraid: a.wbraid || null,
          conversionValueUSD: e.valueUSD,
          currency: 'USD',
          conversionTime: e.at,
          orderId: e.id // dedupe key Google-side too
        });
      }
      return { ok: true, payloads: payloads, skipped: skipped };
    },

    /**
     * Release an upload batch for export — the HUMAN step between "payloads
     * exist" and "an adapter may transmit them". Routes through the runtime
     * gateway (EXPORT_CONVERSIONS, aiAllowed:false): an AI-origin call is
     * hard-blocked and audited. Records a batch in ads_conversion_exports;
     * still transmits NOTHING — a future credentialed adapter reads released
     * batches only.
     */
    async releaseExport(opts) {
      const o = opts || {};
      const gw = global.AAA_RUNTIME_GATEWAY;
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      if (!data()) return { ok: false, error: 'NO_STORE' };
      const queue = await this.uploadQueue(o);
      if (!queue.payloads.length) return { ok: false, error: 'EMPTY_QUEUE', skipped: queue.skipped };
      const run = await gw.run({
        action: 'EXPORT_CONVERSIONS', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'ads_conversion_export', id: null }, detail: { payloads: queue.payloads.length, skipped: queue.skipped.length },
        mutate: async () => {
          const batch = {
            id: ids() && ids().createId ? ids().createId('adsexp') : 'adsexp_' + nowISO(),
            workspaceId: ws(), status: 'released', releasedAt: nowISO(), releasedBy: o.actor || 'owner',
            payloads: queue.payloads, skipped: queue.skipped, transmitted: false
          };
          await data().put('ads_conversion_exports', batch.id, batch);
          return { ok: true, batch: batch };
        }
      });
      if (!run.ok) return run;
      return run.result;
    },

    /** Honest health check. */
    async healthCheck() {
      if (!data()) return { ok: false, error: 'NO_STORE' };
      const all = await this.list();
      return { ok: true, events: all.length, types: Object.keys(TYPES).length };
    }
  };

  global.AAA_ADS_CONVERSIONS = Ledger;
})(typeof window !== 'undefined' ? window : this);
