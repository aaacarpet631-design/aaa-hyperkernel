/*
 * AAA Ad Attribution — the closed-loop spine: click → lead → paid job → the
 * exact profit fed back to the ad algorithm so it hunts payers, not clickers.
 *
 * At intake, the landing page's Google Click ID (gclid) + the search term,
 * keyword, ad group and campaign are attached to the lead. When that lead
 * converts (a job is won / paid), the realized value is recorded against the
 * SAME gclid. conversions() then emits Google-Ads-ready offline-conversion
 * payloads, and roas() reports revenue/profit per campaign|keyword so spend
 * follows margin.
 *
 * Honest + bounded by construction:
 *  - This module NEVER calls the Google Ads API. It GENERATES the upload
 *    payload; transmitting revenue data out is a governed, credentialed step
 *    the owner authorizes elsewhere.
 *  - A conversion with no gclid is NOT emitted — you can't attribute what you
 *    can't key. Nothing is fabricated; thin data yields honest empties.
 *  - roas() aggregates are PII-minimized — keyed by campaign/keyword/source,
 *    never names or phones.
 *  - Deterministic, null-tolerant; methods resolve result objects.
 *
 * Decoupled: own collection keyed by leadId, so it never touches lead-store's
 * source validation or any other store's schema.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'ad_attribution';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function str(v, max) { return v == null ? null : String(v).slice(0, max || 200); }
  function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
  function round(n) { return Math.round(n); }

  async function put(rec) {
    await data().put(COLLECTION, rec.leadId, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COLLECTION, rec.leadId, rec); } catch (_) {}
    return rec;
  }

  const Ledger = {
    COLLECTION: COLLECTION,

    /**
     * Pure helper: extract click ids + UTM parameters from a landing-page URL
     * (or query string). Returns an attach()-ready partial; unknown params are
     * ignored, nothing is stored. Never throws — a bad URL yields {}.
     */
    fromUrl(url) {
      const out = {};
      if (!url) return out;
      let qs = null;
      try {
        const s = String(url);
        const q = s.indexOf('?') !== -1 ? s.slice(s.indexOf('?') + 1) : (s.indexOf('=') !== -1 ? s : '');
        qs = new global.URLSearchParams(q);
        const path = s.indexOf('://') !== -1 ? s.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] : (s.indexOf('?') > 0 ? s.split('?')[0] : null);
        if (path) out.landingPage = path;
      } catch (_) { return out; }
      const map = { gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_term: 'utmTerm', utm_content: 'utmContent' };
      Object.keys(map).forEach(function (k) { const v = qs.get(k); if (v) out[map[k]] = v; });
      return out;
    },

    /**
     * Attach ad attribution to a lead at intake (Phase 2). Upsert by leadId.
     * gclid (or gbraid/wbraid for iOS/app) is the join key back to Google.
     *
     * The record is built by WHITELIST — a caller can pass a whole intake blob
     * and no name/phone/email/address ever lands in this collection.
     * consent is 'granted'|'denied'|'unknown'; only 'granted' records are
     * eligible for any first-party-data upload downstream.
     */
    async attach(leadId, attribution) {
      if (!leadId) return { ok: false, error: 'NO_LEAD' };
      if (!data() || !data().put) return { ok: false, error: 'NO_STORE' };
      const a = attribution || {};
      let prior = null;
      try { prior = await data().get(COLLECTION, leadId); } catch (_) { prior = null; }
      const p = mine(prior) ? prior : {};
      const consent = ['granted', 'denied', 'unknown'].indexOf(a.consent) !== -1 ? a.consent : null;
      // Upsert semantics: a provided field updates; an omitted field PRESERVES
      // the prior value (so a second attach can't null out the campaign/gclid).
      const rec = {
        leadId: String(leadId),
        workspaceId: ws(),
        gclid: str(a.gclid, 256) || p.gclid || null,
        gbraid: str(a.gbraid, 256) || p.gbraid || null,
        wbraid: str(a.wbraid, 256) || p.wbraid || null,
        keyword: str(a.keyword, 160) || p.keyword || null,
        adGroup: str(a.adGroup, 160) || p.adGroup || null,
        campaign: str(a.campaign, 160) || p.campaign || null,
        searchTerm: str(a.searchTerm, 200) || p.searchTerm || null,
        source: str(a.source, 48) || p.source || 'google_ads',
        landingPage: str(a.landingPage, 300) || p.landingPage || null,
        // UTM set (Slice 1: measurement foundation)
        utmSource: str(a.utmSource, 120) || p.utmSource || null,
        utmMedium: str(a.utmMedium, 120) || p.utmMedium || null,
        utmCampaign: str(a.utmCampaign, 160) || p.utmCampaign || null,
        utmTerm: str(a.utmTerm, 160) || p.utmTerm || null,
        utmContent: str(a.utmContent, 160) || p.utmContent || null,
        // how the lead arrived (form|call|chat|lsa|portal) — not WHO it is
        channel: str(a.channel, 32) || p.channel || null,
        // coarse geo only (service-area analysis); never a street address
        city: str(a.city, 80) || p.city || null,
        zip: str(a.zip, 16) || p.zip || null,
        // first-party-data consent state; 'unknown' until explicitly captured
        consent: consent || p.consent || 'unknown',
        capturedAt: p.capturedAt || a.capturedAt || nowISO(),
        conversion: p.conversion || null
      };
      try { await put(rec); } catch (_) { return { ok: false, error: 'WRITE_FAILED' }; }
      return { ok: true, attribution: rec };
    },

    async get(leadId) {
      try { const r = await data().get(COLLECTION, leadId); return mine(r) ? r : null; } catch (_) { return null; }
    },

    async list() {
      try { return ((await data().list(COLLECTION)) || []).filter(mine); } catch (_) { return []; }
    },

    /**
     * Record the realized conversion for an attributed lead (Phase 4). value is
     * the money the click ultimately produced — revenue by default, or profit
     * when you want Google optimizing for MARGIN. Returns the upload-ready
     * payload (NOT uploaded).
     */
    async recordConversion(leadId, conv) {
      const rec = await this.get(leadId);
      if (!rec) return { ok: false, error: 'NO_ATTRIBUTION', leadId: String(leadId) };
      const c = conv || {};
      const value = numOrNull(c.valueUSD);
      if (value == null) return { ok: false, error: 'NO_VALUE' };
      rec.conversion = {
        valueUSD: round(value),
        kind: c.kind === 'profit' ? 'profit' : 'revenue',
        at: c.at || nowISO(),
        sourceRef: str(c.sourceRef, 80) // e.g. the quoteId/invoiceId that closed it
      };
      try { await put(rec); } catch (_) { return { ok: false, error: 'WRITE_FAILED' }; }
      return { ok: true, conversion: rec.conversion, payload: payloadFor(rec) };
    },

    /**
     * Google-Ads-ready offline-conversion payloads for every attributed lead
     * that converted AND has a click id. The thing you'd upload — generated,
     * never transmitted here.
     */
    async conversions(opts) {
      const o = opts || {};
      const all = await this.list();
      return all
        .filter(function (r) { return r.conversion && (r.gclid || r.gbraid || r.wbraid); })
        .filter(function (r) { return !o.kind || r.conversion.kind === o.kind; })
        .map(payloadFor);
    },

    /**
     * ROAS by dimension ('campaign'|'adGroup'|'keyword'|'source'). Revenue and
     * profit are summed from recorded conversions; pass opts.spendByKey
     * { [key]: spendUSD } to get a true ROAS ratio — otherwise spend is null
     * (we don't invent ad spend we don't have). PII-min: keyed, never named.
     */
    async roas(opts) {
      const o = opts || {};
      const dim = ['campaign', 'adGroup', 'keyword', 'source'].indexOf(o.dimension) !== -1 ? o.dimension : 'campaign';
      const spend = o.spendByKey || null;
      const rows = {};
      (await this.list()).forEach(function (r) {
        const key = r[dim] || '(unattributed)';
        const row = rows[key] || (rows[key] = { key: key, leads: 0, conversions: 0, revenueUSD: 0, profitUSD: 0 });
        row.leads++;
        if (r.conversion) {
          row.conversions++;
          if (r.conversion.kind === 'profit') row.profitUSD += r.conversion.valueUSD;
          else row.revenueUSD += r.conversion.valueUSD;
        }
      });
      const out = Object.keys(rows).map(function (k) {
        const row = rows[k];
        const s = spend && spend[k] != null ? Number(spend[k]) : null;
        row.spendUSD = s;
        row.roas = (s && s > 0) ? Math.round((row.revenueUSD / s) * 100) / 100 : null;
        row.conversionRatePct = row.leads ? Math.round((row.conversions / row.leads) * 100) : 0;
        return row;
      });
      out.sort(function (a, b) { return (b.revenueUSD + b.profitUSD) - (a.revenueUSD + a.profitUSD); });
      return { ok: true, dimension: dim, rows: out };
    }
  };

  // Google offline-conversion shape (gclid + value + time), upload-ready.
  function payloadFor(r) {
    return {
      leadId: r.leadId,
      gclid: r.gclid || null, gbraid: r.gbraid || null, wbraid: r.wbraid || null,
      conversionValueUSD: r.conversion ? r.conversion.valueUSD : null,
      currency: 'USD',
      conversionTime: r.conversion ? r.conversion.at : null,
      kind: r.conversion ? r.conversion.kind : null,
      campaign: r.campaign || null, adGroup: r.adGroup || null, keyword: r.keyword || null
    };
  }

  global.AAA_AD_ATTRIBUTION = Ledger;
})(typeof window !== 'undefined' ? window : this);
