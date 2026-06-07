/*
 * AAA Outcome Learning Store — what won/lost quotes teach us.
 *
 * Pure, read-only analytics over the owner-only `quotes` collection (which
 * carries margin, risk, quoted vs final price, lead source, zip, won/lost
 * reason, and status history). It aggregates resolved (won|lost) quotes into
 * segments — by service type, zip, lead source, price band, margin band, and
 * risk band — and measures win rate, average quote/final price, average margin,
 * loss reasons, and follow-up effectiveness.
 *
 * It produces NUMBERS ONLY. It never changes a price, never writes a quote, and
 * never posts anything. The Pricing Optimizer consumes these aggregates to make
 * (human-reviewed) recommendations. Every field access is null-tolerant so a
 * malformed/partial quote can never throw.
 */
;(function (global) {
  'use strict';

  function quotes() { return global.AAA_QUOTES; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }
  function isResolved(q) { return q && (q.status === 'won' || q.status === 'lost'); }
  function isWon(q) { return q && q.status === 'won'; }

  // Band helpers — deterministic, null-tolerant.
  function priceBand(v) { v = num(v); if (v <= 0) return 'unknown'; if (v < 200) return '<$200'; if (v < 500) return '$200–500'; if (v < 1000) return '$500–1k'; if (v < 2500) return '$1k–2.5k'; return '$2.5k+'; }
  function marginBand(pct) { if (pct == null || !isFinite(pct)) return 'unknown'; if (pct < 15) return 'thin (<15%)'; if (pct < 25) return 'target (15–25%)'; if (pct < 40) return 'healthy (25–40%)'; return 'high (40%+)'; }
  function riskBand(r) { if (r == null || !isFinite(r)) return 'unknown'; if (r < 30) return 'low'; if (r < 60) return 'medium'; return 'high'; }
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : []; return s.length ? s.slice().sort().join(' + ') : 'unspecified'; }

  function emptyGroup(key) { return { key: key, count: 0, won: 0, lost: 0, quoteIds: [], _quotes: [], _finals: [], _margins: [], lossReasons: {} }; }
  function finalizeGroup(g) {
    const winRate = g.count ? round(g.won / g.count) : null;
    return {
      key: g.key, count: g.count, won: g.won, lost: g.lost,
      winRate: winRate,
      avgQuote: g._quotes.length ? round(mean(g._quotes)) : null,
      avgFinalPrice: g._finals.length ? round(mean(g._finals)) : null,
      avgMarginPct: g._margins.length ? Math.round(mean(g._margins)) : null,
      lossReasons: g.lossReasons,
      quoteIds: g.quoteIds.slice(0, 50)
    };
  }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  function groupBy(list, keyFn) {
    const map = {};
    list.forEach((q) => {
      const k = keyFn(q); if (k == null) return;
      const g = map[k] || (map[k] = emptyGroup(k));
      g.count++; g.quoteIds.push(q.quoteId || q.id);
      if (isWon(q)) { g.won++; if (num(q.finalPrice) > 0) g._finals.push(num(q.finalPrice)); }
      else { g.lost++; const r = (q.wonLostReason || 'unspecified'); g.lossReasons[r] = (g.lossReasons[r] || 0) + 1; }
      if (num(q.customerTotal) > 0) g._quotes.push(num(q.customerTotal));
      if (q.marginPct != null && isFinite(q.marginPct)) g._margins.push(num(q.marginPct));
    });
    return Object.keys(map).map((k) => finalizeGroup(map[k])).sort((a, b) => b.count - a.count);
  }

  const Store = {
    BANDS: { priceBand: priceBand, marginBand: marginBand, riskBand: riskBand },

    /** Full aggregation snapshot. Read-only; safe to call anytime. */
    async aggregate() {
      const all = quotes() ? await quotes().list() : [];
      const resolved = all.filter(isResolved);
      const won = resolved.filter(isWon);
      const lost = resolved.filter((q) => !isWon(q));

      const overall = {
        total: all.length, resolved: resolved.length, won: won.length, lost: lost.length,
        winRate: resolved.length ? round(won.length / resolved.length) : null,
        avgQuote: avgField(resolved, (q) => num(q.customerTotal)),
        avgFinalPrice: avgField(won, (q) => num(q.finalPrice)),
        avgMarginPct: avgIntField(resolved, (q) => q.marginPct)
      };

      const lossReasons = {};
      lost.forEach((q) => { const r = q.wonLostReason || 'unspecified'; lossReasons[r] = (lossReasons[r] || 0) + 1; });

      return {
        ok: true,
        overall: overall,
        byServiceType: groupBy(resolved, serviceKey),
        byZip: groupBy(resolved, (q) => q.zip || 'unknown'),
        byLeadSource: groupBy(resolved, (q) => q.leadSource || 'unknown'),
        byPriceBand: groupBy(resolved, (q) => priceBand(q.customerTotal)),
        byMarginBand: groupBy(resolved, (q) => marginBand(q.marginPct)),
        byRiskBand: groupBy(resolved, (q) => riskBand(q.risk)),
        lossReasons: Object.keys(lossReasons).map((k) => ({ reason: k, count: lossReasons[k] })).sort((a, b) => b.count - a.count),
        followUp: this._followUp(resolved),
        // Low-margin wins surfaced directly (a key risk signal).
        lowMarginWins: won.filter((q) => q.marginPct != null && q.marginPct < 15)
          .map((q) => ({ quoteId: q.quoteId || q.id, customer: q.customerName, marginPct: q.marginPct, finalPrice: num(q.finalPrice), serviceType: serviceKey(q) })),
        highRiskResolved: resolved.filter((q) => riskBand(q.risk) === 'high')
          .map((q) => ({ quoteId: q.quoteId || q.id, risk: q.risk, status: q.status, customer: q.customerName }))
      };
    },

    /**
     * Follow-up effectiveness: close rate for quotes that went through a
     * follow_up_due step vs those that didn't, and avg sent→resolved days for
     * won vs lost (a proxy for "delays hurting close rate").
     */
    _followUp(resolved) {
      const hadFollow = resolved.filter((q) => Array.isArray(q.statusHistory) && q.statusHistory.some((h) => h && h.status === 'follow_up_due'));
      const noFollow = resolved.filter((q) => !(Array.isArray(q.statusHistory) && q.statusHistory.some((h) => h && h.status === 'follow_up_due')));
      const wr = (list) => list.length ? round(list.filter(isWon).length / list.length) : null;
      const days = (q) => {
        const sent = sentAt(q); const res = Date.parse(q.resolvedAt || '');
        return (isFinite(sent) && isFinite(res) && res >= sent) ? (res - sent) / 86400000 : null;
      };
      const wonDays = resolved.filter(isWon).map(days).filter((n) => n != null);
      const lostDays = resolved.filter((q) => !isWon(q)).map(days).filter((n) => n != null);
      return {
        withFollowUp: { count: hadFollow.length, winRate: wr(hadFollow) },
        withoutFollowUp: { count: noFollow.length, winRate: wr(noFollow) },
        avgDaysToWin: wonDays.length ? round(mean(wonDays)) : null,
        avgDaysToLoss: lostDays.length ? round(mean(lostDays)) : null
      };
    }
  };

  function avgField(list, fn) { const v = list.map(fn).filter((n) => n > 0); return v.length ? round(mean(v)) : null; }
  function avgIntField(list, fn) { const v = list.map(fn).filter((n) => n != null && isFinite(n)); return v.length ? Math.round(mean(v.map(Number))) : null; }
  function sentAt(q) {
    if (q && q.sentAt) { const t = Date.parse(q.sentAt); if (isFinite(t)) return t; }
    const h = Array.isArray(q && q.statusHistory) ? q.statusHistory.find((x) => x && x.status === 'sent') : null;
    return h ? Date.parse(h.at || '') : NaN;
  }

  global.AAA_OUTCOME_LEARNING = Store;
})(typeof window !== 'undefined' ? window : this);
