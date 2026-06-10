/*
 * AAA Competitor Intelligence — competitive pressure per market.
 *
 * The kernel has no live competitor feed (pricing scrapes, ad-share, review
 * counts). Rather than fabricate pressure, this engine is honest by
 * construction: with no observations it returns insufficient_data. It exposes a
 * governed ingestion seam (observe) so an external crawler — the next organ —
 * can feed real competitor signals under one schema, and only then does
 * pressure become a real number. Stored append-only in competitor_signals.
 *
 * Output: { competitorPressure (0..1|null), competitors, confidence, status }.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'competitor_signals';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function clamp01(x) { const n = Number(x); return isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

  const Engine = {
    COLLECTION: COLLECTION,

    /** Ingest a competitor observation (append-only). pressure 0..1 per market. */
    async observe(obs) {
      const o = obs || {};
      const id = newId('comp');
      const rec = { id: id, workspaceId: ws(), competitor: o.competitor || 'unknown', zip: o.zip == null ? null : String(o.zip), pressure: clamp01(o.pressure), source: o.source || 'manual', observedAt: o.observedAt || nowISO() };
      await data().put(COLLECTION, id, rec);
      return { ok: true, record: rec };
    },

    /** Competitive pressure for a market (zip) or overall. */
    async pressure(zip) {
      const all = (await data().list(COLLECTION)).filter(mine).filter((r) => zip == null || String(r.zip) === String(zip));
      const vals = all.map((r) => r.pressure).filter((v) => v != null);
      if (!vals.length) return { competitorPressure: null, competitors: 0, confidence: 0, status: 'insufficient_data', note: 'no competitor feed wired yet' };
      return { competitorPressure: Math.round(mean(vals) * 1000) / 1000, competitors: new Set(all.map((r) => r.competitor)).size, confidence: Math.min(0.85, vals.length / 8), status: 'derived' };
    }
  };

  global.AAA_COMPETITOR_INTELLIGENCE = Engine;
})(typeof window !== 'undefined' ? window : this);
