/*
 * AAA Win Probability Engine — how likely is this estimate to close.
 *
 * Grounds the probability in real comparable history: it prefers the Learning
 * Fabric's recall() (win rate for jobs like this), and falls back to a direct
 * win-rate over comparable quotes (same service / price band). With no
 * comparables it returns null + insufficient_data — it never guesses. The
 * confidence scales with the comparable sample size. Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function fabric() { return global.AAA_LEARNING_FABRIC; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  const WON = ['won', 'accepted', 'closed_won']; const LOST = ['lost', 'rejected', 'closed_lost'];
  function band(total) { const v = num(total); if (v == null) return 'unknown'; if (v < 500) return 'a'; if (v < 1000) return 'b'; if (v < 2500) return 'c'; if (v < 5000) return 'd'; return 'e'; }
  function svc(q) { const s = Array.isArray(q.serviceType) ? q.serviceType : (q.serviceType ? [q.serviceType] : []); return s.map(lc).sort().join('+') || 'unspecified'; }

  const Engine = {
    /** @param estimate {serviceType, total, zip} → {winProbability, sample, confidence, status, basis}. */
    async winProbability(estimate) {
      const e = estimate || {};
      // 1) Learning Fabric recall, if available.
      if (fabric() && fabric().recall) {
        try { const r = await fabric().recall({ serviceType: e.serviceType, total: e.total, zip: e.zip }); if (r && r.sample >= 3 && r.winRate != null) return { winProbability: Math.round(r.winRate * 1000) / 1000, sample: r.sample, confidence: Math.min(0.9, r.sample / 15), status: 'derived', basis: 'learning_fabric' }; } catch (_) {}
      }
      // 2) Direct comparable win rate.
      const quotes = await list('quotes');
      const tBand = band(e.total); const tSvc = svc(e);
      const comparable = quotes.filter((q) => (WON.indexOf(lc(q.status)) !== -1 || LOST.indexOf(lc(q.status)) !== -1) && band(q.total) === tBand && svc(q) === tSvc);
      const won = comparable.filter((q) => WON.indexOf(lc(q.status)) !== -1).length;
      if (comparable.length >= 3) return { winProbability: Math.round((won / comparable.length) * 1000) / 1000, sample: comparable.length, confidence: Math.min(0.85, comparable.length / 15), status: 'derived', basis: 'comparable_quotes' };
      // 3) Not enough comparables → honest.
      return { winProbability: null, sample: comparable.length, confidence: 0, status: 'insufficient_data', basis: 'no_comparables' };
    }
  };

  global.AAA_WIN_PROBABILITY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
