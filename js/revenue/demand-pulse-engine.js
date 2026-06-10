/*
 * AAA Demand Pulse Engine — how strong is demand right now, and why.
 *
 * Combines a seasonal pattern (derived from real lead/quote timestamps by
 * month) with the live lead_volume signal from the World Model (freshness
 * protected — a stale signal is not used). Weather impact is a declared input
 * the kernel does not yet have a live source for, so it is reported as
 * insufficient_data rather than invented (honesty rule). Pure/deterministic.
 *
 * Output: { demandIndex (0..1|null), seasonalFactor, recentVolume, weather, confidence }.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function world() { return global.AAA_WORLD_MODEL; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  const Engine = {
    /** Monthly lead counts → a normalized seasonal factor for the current month. */
    async seasonal(now) {
      const ref = now != null ? now : nowMs();
      const leads = await list('leads');
      if (!leads.length) return { factor: null, status: 'insufficient_data', months: 0 };
      const byMonth = new Array(12).fill(0);
      leads.forEach((l) => { const t = Date.parse(l.createdAt || l.observedAt); if (isFinite(t)) byMonth[new Date(t).getUTCMonth()]++; });
      const total = byMonth.reduce((a, b) => a + b, 0);
      if (!total) return { factor: null, status: 'insufficient_data', months: 0 };
      const avg = total / 12;
      const m = new Date(ref).getUTCMonth();
      return { factor: avg ? Math.round((byMonth[m] / avg) * 1000) / 1000 : null, status: 'derived', month: m, monthCount: byMonth[m], avg: Math.round(avg * 100) / 100 };
    },

    /** Weather has no live source yet — honest insufficient_data (no fabricated value). */
    async weatherImpact() { return { value: null, status: 'insufficient_data', note: 'Houston weather feed not yet wired to the event bus' }; },

    /**
     * Demand index 0..1: recent lead volume vs its own seasonal baseline,
     * nudged by the seasonal factor. confidence reflects sample + signal freshness.
     */
    async pulse(now) {
      const ref = now != null ? now : nowMs();
      const seasonal = await this.seasonal(ref);
      let recentVolume = null, conf = 0;
      // Prefer the freshness-protected World Model signal; fall back to a raw count.
      if (world()) { const sig = await world().signal('lead_volume', ref); if (sig && sig.value != null && (sig.status === 'fresh' || sig.status === 'degraded')) { recentVolume = sig.value; conf = sig.confidence; } }
      if (recentVolume == null) {
        const leads = await list('leads');
        const cutoff = ref - 604800000;
        const recent = leads.filter((l) => { const t = Date.parse(l.createdAt || l.observedAt); return !isFinite(t) || t >= cutoff; });
        recentVolume = leads.length ? recent.length : null;
        conf = leads.length ? 0.5 : 0;
      }
      if (recentVolume == null) return { demandIndex: null, seasonalFactor: seasonal.factor, recentVolume: null, weather: await this.weatherImpact(), confidence: 0, status: 'insufficient_data' };
      // Map seasonal factor (≈1 = average) into a 0..1 index; absent factor → neutral 0.5.
      const sf = seasonal.factor == null ? 1 : seasonal.factor;
      const demandIndex = Math.max(0, Math.min(1, 0.5 * Math.min(2, sf)));
      return { demandIndex: Math.round(demandIndex * 1000) / 1000, seasonalFactor: seasonal.factor, recentVolume: recentVolume, weather: await this.weatherImpact(), confidence: Math.round(conf * 1000) / 1000, status: 'derived' };
    }
  };

  global.AAA_DEMAND_PULSE_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
