/*
 * AAA Creative Evolution Engine — A/B ad creative as governed, scored variants.
 *
 * Holds creative variants (append-only) and scores them ONLY on real recorded
 * performance (impressions, clicks, closes). A variant with no data is
 * unproven (null score), never assumed good. recommend() returns the best
 * proven variant, or insufficient_data when nothing has been measured —
 * matching the kernel's honesty rule. Deterministic; writes only its own store.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'ad_creatives';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  const Engine = {
    COLLECTION: COLLECTION,

    /** Register a creative variant (append-only). */
    async addVariant(v) {
      const o = v || {};
      const id = newId('crv');
      const rec = { id: id, workspaceId: ws(), intent: o.intent || 'general', headline: o.headline || '', body: o.body || '', impressions: 0, clicks: 0, closes: 0, createdAt: nowISO() };
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    /** Record measured performance for a variant (append-only event, summed on read). */
    async recordPerformance(variantId, perf) {
      const p = perf || {};
      const id = newId('crvp');
      await data().put('ad_creative_perf', id, { id: id, workspaceId: ws(), variantId: variantId, impressions: num(p.impressions), clicks: num(p.clicks), closes: num(p.closes), at: nowISO() });
      return { ok: true };
    },

    /** Variants with summed real performance + a score (null when unproven). */
    async variants(intent) {
      const all = (await data().list(COLLECTION)).filter(mine).filter((v) => intent == null || v.intent === intent);
      const perf = (await data().list('ad_creative_perf')).filter(mine);
      return all.map((v) => {
        const p = perf.filter((x) => x.variantId === v.id);
        const impressions = p.reduce((a, x) => a + x.impressions, 0);
        const clicks = p.reduce((a, x) => a + x.clicks, 0);
        const closes = p.reduce((a, x) => a + x.closes, 0);
        const ctr = impressions ? clicks / impressions : null;
        const closeRate = clicks ? closes / clicks : null;
        const score = (impressions && clicks) ? Math.round((ctr * closeRate) * 1e6) / 1e6 : null; // proven only
        return { id: v.id, intent: v.intent, headline: v.headline, impressions: impressions, clicks: clicks, closes: closes, ctr: ctr, closeRate: closeRate, score: score };
      }).sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
    },

    /** Best proven variant, or insufficient_data. */
    async recommend(intent) {
      const vs = await this.variants(intent);
      const proven = vs.filter((v) => v.score != null);
      if (!proven.length) return { status: 'insufficient_data', recommended: null, candidates: vs.length };
      return { status: 'derived', recommended: proven[0], lift: proven.length > 1 && proven[1].score ? Math.round((proven[0].score / proven[1].score - 1) * 1000) / 1000 : null };
    }
  };

  global.AAA_CREATIVE_EVOLUTION_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
