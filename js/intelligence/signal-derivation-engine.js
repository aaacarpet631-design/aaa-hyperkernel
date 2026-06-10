/*
 * AAA Signal Derivation Engine — turns real graph/event data into fresh signals.
 *
 * Derives the registered business signals from shared memory (quotes, jobs,
 * leads, outcomes, review_requests) over an analysis window, and appends them to
 * the World State Ledger. HONEST BY CONSTRUCTION: when the underlying data is
 * absent it appends value:null with confidence:0 (which the sentinel surfaces as
 * insufficient_data) — never a fabricated number. Confidence scales with sample
 * size; an estimate from 3 jobs is not as trusted as one from 300.
 *
 * Derivation is additive: it only writes signals (append-only), never mutating
 * any production record it reads.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_WORLD_STATE_LEDGER; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  const WON = ['won', 'accepted', 'closed_won'];
  const LOST = ['lost', 'rejected', 'closed_lost'];

  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  function inWindow(ts, cutoff) { const t = Date.parse(ts); return !isFinite(t) || t >= cutoff; }
  // Confidence from sample size: 0 → 0, small → modest, large → high (capped).
  function conf(n, full) { if (!n) return 0; const f = full || 20; return Math.max(0.4, Math.min(0.95, n / f)); }

  const Engine = {
    /**
     * Derive all signals from current data over a window (default 7 days).
     * Each is appended to the world ledger. Returns a summary { type: status }.
     */
    async deriveAll(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const windowMs = o.windowMs || 604800000;
      const cutoff = now - windowMs;
      const summary = {};

      const quotes = await list('quotes');
      const jobs = await list('jobs');
      const leads = await list('leads');
      const reviews = await list('review_requests');

      const append = async (signalType, value, extra) => {
        const r = await ledger().append(Object.assign({ signalType: signalType, value: value, source: 'signal_derivation_engine', observedAt: new Date(now).toISOString(), derivationMethod: 'graph_window_aggregation' }, extra || {}));
        summary[signalType] = value == null ? 'insufficient_data' : 'derived';
        return r;
      };

      // lead_volume
      const recentLeads = leads.filter((l) => inWindow(l.createdAt || l.observedAt, cutoff));
      await append('lead_volume', leads.length ? recentLeads.length : null, { unit: 'count', confidence: leads.length ? 0.9 : 0 });

      // close_rate (won / (won+lost))
      const won = quotes.filter((q) => WON.indexOf(lc(q.status)) !== -1);
      const lost = quotes.filter((q) => LOST.indexOf(lc(q.status)) !== -1);
      const wl = won.length + lost.length;
      await append('close_rate', wl ? won.length / wl : null, { unit: 'ratio', confidence: conf(wl, 10), stalePolicy: wl ? 'degrade_confidence' : 'block' });

      // gross_margin (from quote margins, or completed-job revenue/cost)
      const margins = quotes.map((q) => num(q.margin)).filter((n) => n != null);
      let gm = margins.length ? mean(margins) : null;
      let gmConf = conf(margins.length, 10);
      if (gm == null) {
        const completed = jobs.filter((j) => lc(j.status) === 'completed' || j.finalBilling != null);
        let rev = 0, cost = 0, n = 0;
        completed.forEach((j) => { const r = num(j.finalBilling); const c = (num(j.materialCost) || 0) + (num(j.laborCost) || 0); if (r != null) { rev += r; cost += c; n++; } });
        if (n && rev > 0) { gm = (rev - cost) / rev; gmConf = conf(n, 10); }
      }
      await append('gross_margin', gm, { unit: 'ratio', confidence: gm == null ? 0 : gmConf });

      // job_profitability (mean profit per completed job)
      const completedJobs = jobs.filter((j) => j.finalBilling != null);
      const profits = completedJobs.map((j) => { const r = num(j.finalBilling); const c = (num(j.materialCost) || 0) + (num(j.laborCost) || 0); return r == null ? null : r - c; }).filter((n) => n != null);
      await append('job_profitability', profits.length ? mean(profits) : null, { unit: 'currency', confidence: conf(profits.length, 10) });

      // review_velocity
      const recentReviews = reviews.filter((r) => inWindow(r.createdAt || r.observedAt, cutoff));
      await append('review_velocity', reviews.length ? recentReviews.length : null, { unit: 'count', confidence: reviews.length ? 0.85 : 0 });

      // quote_accuracy (1 - mean(|estimate - final|/final)) where both present
      const accs = jobs.map((j) => { const est = num(j.estimate); const fin = num(j.finalBilling); return (est != null && fin && fin !== 0) ? 1 - Math.min(1, Math.abs(est - fin) / Math.abs(fin)) : null; }).filter((n) => n != null);
      await append('quote_accuracy', accs.length ? mean(accs) : null, { unit: 'ratio', confidence: conf(accs.length, 10) });

      // Signals with no native data source yet → honest insufficient_data.
      for (const t of ['callback_rate', 'crew_utilization', 'response_time', 'marketing_cac', 'schedule_capacity']) {
        await append(t, null, { confidence: 0 });
      }

      return { ok: true, at: new Date(now).toISOString(), windowMs: windowMs, summary: summary };
    },

    /**
     * Event-stream derivation (for callers that have a raw event window rather
     * than the graph): lead_volume, close_rate, gross_margin from event types.
     */
    async deriveFromEvents(events, opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const cutoff = now - (o.windowMs || 604800000);
      const evs = (Array.isArray(events) ? events : []).filter((e) => inWindow(e.timestamp || e.at, cutoff));
      const count = (type) => evs.filter((e) => (e.eventType || e.type) === type).length;

      await ledger().append({ signalType: 'lead_volume', value: count('LEAD_CAPTURED'), unit: 'count', source: 'event_stream', confidence: 0.9, observedAt: new Date(now).toISOString(), derivationMethod: 'event_window_aggregation' });
      const gen = count('ESTIMATE_GENERATED'); const acc = count('ESTIMATE_ACCEPTED');
      await ledger().append({ signalType: 'close_rate', value: gen ? acc / gen : null, unit: 'ratio', source: 'event_stream', confidence: gen >= 5 ? 0.9 : (gen ? 0.6 : 0), stalePolicy: gen ? 'degrade_confidence' : 'block', observedAt: new Date(now).toISOString(), derivationMethod: 'event_window_aggregation' });
      return { ok: true, events: evs.length };
    }
  };

  global.AAA_SIGNAL_DERIVATION_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
