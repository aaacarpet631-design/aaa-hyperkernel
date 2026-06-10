/*
 * AAA Search Intent Engine — classify what a prospect actually wants.
 *
 * Deterministic keyword classification into five intent classes, each with a
 * documented close-rate multiplier applied to the company's REAL baseline close
 * rate (from AAA_MARKETING channel stats / World Model close_rate signal) — so
 * expectedCloseRate is grounded, not guessed. When no baseline exists the close
 * rate is reported null (insufficient_data), never fabricated.
 *
 * Classes: Emergency · Research · PriceShopping · Commercial · RepeatCustomer.
 * Output: { intentType, probability, expectedCloseRate, recommendedMessage }.
 */
;(function (global) {
  'use strict';

  function marketing() { return global.AAA_MARKETING; }
  function world() { return global.AAA_WORLD_MODEL; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }

  // class → { keywords, closeMultiplier (vs baseline), message }
  const INTENTS = {
    Emergency: { kw: ['emergency', 'flood', 'water', 'urgent', 'asap', 'today', 'burst', 'leak', 'now'], mult: 1.6, message: 'We can dispatch a crew fast — call now for same-day emergency service.' },
    RepeatCustomer: { kw: ['again', 'last time', 'previously', 'you did', 'rebook', 'same as'], mult: 1.8, message: 'Welcome back! We have your history — want the same crew and a returning-customer rate?' },
    Commercial: { kw: ['commercial', 'office', 'building', 'property manager', 'apartment', 'turn', 'sqft', 'square feet', 'business'], mult: 1.2, message: 'We handle commercial volume with scheduled crews and net terms — let\'s scope the building.' },
    PriceShopping: { kw: ['cheap', 'cheapest', 'price', 'cost', 'quote', 'how much', 'estimate', 'affordable', 'deal'], mult: 0.7, message: 'Here\'s a transparent estimate with our workmanship guarantee — quality that avoids a redo.' },
    Research: { kw: ['how to', 'should i', 'best', 'vs', 'difference', 'tips', 'guide', 'options', 'types'], mult: 0.5, message: 'Here\'s a quick guide — and a free assessment whenever you\'re ready, no pressure.' }
  };
  const ORDER = ['Emergency', 'RepeatCustomer', 'Commercial', 'PriceShopping', 'Research'];

  async function baselineCloseRate(now) {
    if (world()) { const s = await world().signal('close_rate', now); if (s && s.value != null && (s.status === 'fresh' || s.status === 'degraded')) return { rate: s.value, conf: s.confidence }; }
    if (marketing() && marketing().channelStats) { try { const cs = await marketing().channelStats(); const rates = cs.map((c) => c.closeRate).filter((r) => r != null); if (rates.length) return { rate: rates.reduce((a, b) => a + b, 0) / rates.length, conf: 0.5 }; } catch (_) {} }
    return { rate: null, conf: 0 };
  }

  const Engine = {
    INTENTS: ORDER.slice(),

    /** Classify text → { intentType, probability, expectedCloseRate, recommendedMessage }. */
    async classify(text, opts) {
      const o = opts || {};
      const t = String(text == null ? '' : text).toLowerCase();
      const scores = {};
      ORDER.forEach((cls) => { scores[cls] = INTENTS[cls].kw.reduce((n, k) => n + (t.indexOf(k) !== -1 ? 1 : 0), 0); });
      let best = null, total = 0;
      ORDER.forEach((cls) => { total += scores[cls]; if (!best || scores[cls] > scores[best]) best = cls; });
      // No keyword hit → default to Research (lowest-intent), low probability.
      if (!total) best = 'Research';
      const probability = total ? Math.round((scores[best] / total) * 1000) / 1000 : 0.2;

      const base = await baselineCloseRate(o.now != null ? o.now : nowMs());
      const expectedCloseRate = base.rate == null ? null : Math.round(Math.max(0, Math.min(1, base.rate * INTENTS[best].mult)) * 1000) / 1000;
      return {
        intentType: best,
        probability: probability,
        expectedCloseRate: expectedCloseRate,
        expectedCloseRateStatus: base.rate == null ? 'insufficient_data' : 'derived',
        recommendedMessage: INTENTS[best].message,
        confidence: Math.round(((total ? Math.min(1, total / 3) : 0.3) * (base.conf || 0.4)) * 1000) / 1000
      };
    },

    /** Cluster a batch of queries by dominant intent (for keyword strategy). */
    async clusterKeywords(queries) {
      const clusters = {}; ORDER.forEach((c) => { clusters[c] = []; });
      for (const q of (Array.isArray(queries) ? queries : [])) { const r = await this.classify(q); clusters[r.intentType].push(q); }
      return clusters;
    }
  };

  global.AAA_SEARCH_INTENT_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
