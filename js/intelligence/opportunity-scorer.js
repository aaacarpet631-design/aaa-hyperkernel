/*
 * AAA Opportunity Scorer — Stage-3 entity-level decision layer.
 *
 * Turns the Outcome Learning aggregates (win rates by service type, zip, lead
 * source, price band) into a PER-QUOTE decision object: win probability,
 * expected value (probability × customerTotal), a recommended next action with
 * urgency, and a `basis` that reports exactly which evidence was used. It is
 * read-only intelligence: it never writes a quote, never changes a price, and
 * never sends anything — the Command Deck renders it for a person to act on.
 *
 * Probability model (deterministic — no randomness, no fabrication):
 *   For each segment dimension where the quote's attribute matches a learned
 *   segment, compute a SHRUNK posterior win rate:
 *
 *       posterior = (segment.won + k · overallRate) / (segment.count + k),  k = 3
 *
 *   This is a Beta-style shrinkage toward the company-wide win rate: a
 *   1-sample 100% segment can never claim probability 1.0 — small segments are
 *   pulled toward the overall rate, while large segments dominate the prior.
 *   The final probability is the mean of the available segment posteriors
 *   (method 'segment_blend'). If NO segments match (or the aggregate is not ok
 *   or empty), fall back to the overall win rate (method 'overall_rate'); if
 *   there is no resolved history at all, fall back to a stated 0.5 prior
 *   (method 'uninformed_prior', confidence 'low').
 *
 * Confidence is keyed to the total evidence count behind the segments used
 * (or overall.resolved for 'overall_rate'): >= 10 high, >= 4 medium, else low.
 *
 * Price-band keys reuse AAA_OUTCOME_LEARNING.BANDS.priceBand so lookups always
 * match the learning store's banding (a local replica is kept as a fallback).
 */
;(function (global) {
  'use strict';

  const K = 3; // shrinkage strength (pseudo-observations of the overall rate)
  const OPEN_STATUSES = ['draft', 'reviewed', 'sent', 'follow_up_due'];
  // Catch-all segment keys carry no evidence about a specific quote.
  const NON_KEYS = { unknown: true, unspecified: true };

  function quotes() { return global.AAA_QUOTES; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round4(n) { return Math.round(n * 10000) / 10000; }
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  // Must mirror outcome-learning-store.js serviceKey() — sorted ' + ' join.
  function serviceKey(q) {
    const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : [];
    return s.length ? s.slice().sort().join(' + ') : null;
  }
  // Prefer the learning store's own banding so keys can never drift.
  function priceBandKey(v) {
    const L = learning();
    if (L && L.BANDS && typeof L.BANDS.priceBand === 'function') {
      try { return L.BANDS.priceBand(v); } catch (_) { /* fall through */ }
    }
    v = num(v);
    if (v <= 0) return 'unknown';
    if (v < 200) return '<$200';
    if (v < 500) return '$200–500';
    if (v < 1000) return '$500–1k';
    if (v < 2500) return '$1k–2.5k';
    return '$2.5k+';
  }

  // Segment dimensions: how a quote's attribute maps to an aggregate list key.
  const DIMENSIONS = [
    { dimension: 'serviceType', list: 'byServiceType', keyOf: serviceKey },
    { dimension: 'zip', list: 'byZip', keyOf: (q) => (q && q.zip) || null },
    { dimension: 'leadSource', list: 'byLeadSource', keyOf: (q) => (q && q.leadSource) || null },
    { dimension: 'priceBand', list: 'byPriceBand', keyOf: (q) => priceBandKey(q && q.customerTotal) }
  ];

  function confidenceFor(method, evidenceCount) {
    if (method === 'uninformed_prior') return 'low';
    if (evidenceCount >= 10) return 'high';
    if (evidenceCount >= 4) return 'medium';
    return 'low';
  }

  // Deterministic next action by status + probability.
  function recommend(status, probability) {
    if (status === 'follow_up_due') {
      return { action: { id: 'call_now', label: 'Call now — follow-up due' }, urgency: 'now' };
    }
    if (probability < 0.35) {
      return { action: { id: 'review_pricing', label: 'Review pricing before chasing' }, urgency: 'this_week' };
    }
    if (status === 'sent') {
      if (probability >= 0.6) return { action: { id: 'follow_up', label: 'Follow up — likely to close' }, urgency: 'today' };
      return { action: { id: 'follow_up', label: 'Follow up' }, urgency: 'this_week' };
    }
    if (status === 'draft' || status === 'reviewed') {
      return { action: { id: 'send_quote', label: 'Send the quote' }, urgency: 'today' };
    }
    return { action: { id: 'review_quote', label: 'Review this quote' }, urgency: 'this_week' };
  }

  async function safeAggregate() {
    try {
      const L = learning();
      if (!L || typeof L.aggregate !== 'function') return null;
      const agg = await L.aggregate();
      return agg && agg.ok ? agg : null;
    } catch (_) { return null; }
  }

  const Scorer = {
    K: K, OPEN_STATUSES: OPEN_STATUSES,

    /**
     * Score one quote → decision object.
     * @param {Object} quote a quote record (needs customerTotal/status/segment fields)
     * @param {Object} [opts] { aggregate } — precomputed AAA_OUTCOME_LEARNING.aggregate()
     */
    async score(quote, opts) {
      try {
        if (!quote) return { ok: false, reason: 'NO_QUOTE' };
        const o = opts || {};
        const agg = o.aggregate !== undefined ? o.aggregate : await safeAggregate();
        const amount = num(quote.customerTotal);

        const overall = (agg && agg.ok && agg.overall) ? agg.overall : null;
        const overallRate = (overall && overall.winRate != null && isFinite(overall.winRate)) ? overall.winRate : null;
        const overallCount = overall ? num(overall.resolved) : 0;

        // Collect matching segments (only real keys backed by real evidence).
        const segmentsUsed = [];
        const posteriors = [];
        if (overallRate != null) {
          DIMENSIONS.forEach((d) => {
            const key = d.keyOf(quote);
            if (key == null || NON_KEYS[key]) return;
            const list = Array.isArray(agg[d.list]) ? agg[d.list] : [];
            const g = list.find((s) => s && s.key === key && s.count > 0);
            if (!g) return;
            posteriors.push((num(g.won) + K * overallRate) / (num(g.count) + K));
            segmentsUsed.push({ dimension: d.dimension, key: g.key, winRate: g.winRate, count: g.count });
          });
        }

        let probability, method, evidence;
        if (segmentsUsed.length) {
          probability = mean(posteriors); method = 'segment_blend';
          evidence = segmentsUsed.reduce((s, g) => s + num(g.count), 0);
        } else if (overallRate != null) {
          probability = overallRate; method = 'overall_rate';
          evidence = overallCount;
        } else {
          probability = 0.5; method = 'uninformed_prior'; evidence = 0;
        }
        probability = clamp01(round4(probability));

        const next = recommend(quote.status, probability);
        return {
          ok: true,
          quoteId: quote.quoteId || quote.id || null,
          probability: probability,
          probabilityPct: Math.round(probability * 100 + 1e-9),
          expectedValue: Math.round(probability * amount + 1e-9),
          amount: amount,
          basis: {
            segmentsUsed: segmentsUsed,
            overall: { winRate: overallRate, count: overallCount },
            method: method
          },
          confidence: confidenceFor(method, evidence),
          recommendedAction: next.action,
          urgency: next.urgency
        };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    },

    /** Score every OPEN quote (draft/reviewed/sent/follow_up_due), ranked by expected value. */
    async scoreAll(opts) {
      try {
        if (!quotes() || typeof quotes().list !== 'function') return { ok: false, items: [], reason: 'NO_QUOTE_STORE' };
        if (!learning() || typeof learning().aggregate !== 'function') return { ok: false, items: [], reason: 'NO_LEARNING_STORE' };
        const all = await quotes().list();
        const open = (all || []).filter((q) => q && OPEN_STATUSES.indexOf(q.status) !== -1);
        const agg = await safeAggregate(); // aggregate once, reuse per quote
        const items = [];
        for (const q of open) {
          const d = await this.score(q, Object.assign({}, opts, { aggregate: agg }));
          if (d && d.ok) items.push(d);
        }
        items.sort((a, b) => (b.expectedValue - a.expectedValue) || String(a.quoteId).localeCompare(String(b.quoteId)));
        return { ok: true, items: items, rankedBy: 'expectedValue' };
      } catch (e) {
        return { ok: false, items: [], reason: String((e && e.message) || e) };
      }
    }
  };

  global.AAA_OPPORTUNITY_SCORER = Scorer;
})(typeof window !== 'undefined' ? window : this);
