/*
 * AAA Intelligence Collectors — Layer 1 (Data Collection).
 *
 * Deterministic rollups over REAL shared memory for each analysis team. No model
 * calls, no fabrication: every number here is derived from jobs, outcomes,
 * customers, reviews, and agent decisions actually in the store. Thin data is
 * reported honestly via `sample` counts and a `status` of 'warming_up' so the
 * analysts (and the dashboard) never pretend to know more than they do.
 *
 * These collectors are the single source of real numbers the whole intelligence
 * layer reasons over — the analysts in Layer 2 are forbidden from inventing
 * figures, so the quality of the org rests here.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  const MIN = 3; // below this many data points a domain is "warming up"

  function round(n, p) { const f = Math.pow(10, p == null ? 2 : p); return Math.round(n * f) / f; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }

  /** Parse "$200-$400" / "$250" → midpoint number (or null). */
  function quoteMidpoint(range) {
    if (range == null) return null;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    return mean(nums.map(Number));
  }

  function monthKey(ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  // Primary service type for a job = its first estimate's type (best-effort).
  function jobService(job) {
    const ests = job && Array.isArray(job.estimates) ? job.estimates : [];
    return (ests[0] && ests[0].type) || job.serviceType || 'unspecified';
  }

  async function load() {
    const d = data();
    const out = { jobs: [], customers: [], outcomes: [], reviews: [], decisions: [] };
    if (!d) return out;
    out.jobs = await d.list('jobs');
    out.customers = await d.list('customers');
    out.outcomes = await d.list('outcomes');
    try { out.reviews = await d.list('reviews'); } catch (_) { out.reviews = []; }
    out.decisions = await d.list('agent_decisions');
    return out;
  }

  const Collectors = {
    quoteMidpoint: quoteMidpoint,

    /** Revenue: realized revenue, ticket size, by-service, by-month trend. */
    async revenue() {
      const m = await load();
      const won = m.outcomes.filter(function (o) { return o.result === 'won'; });
      const amounts = won.map(function (o) { return o.finalAmount; }).filter(function (n) { return typeof n === 'number' && n > 0; });
      const jobById = {}; m.jobs.forEach(function (j) { jobById[j.id] = j; });

      // By service type (realized).
      const byService = {};
      won.forEach(function (o) {
        const job = jobById[o.jobId];
        if (!job || typeof o.finalAmount !== 'number') return;
        const s = jobService(job);
        const b = byService[s] || (byService[s] = { service: s, jobs: 0, revenue: 0 });
        b.jobs++; b.revenue += o.finalAmount;
      });

      // Monthly trend (realized revenue per month).
      const byMonth = {};
      won.forEach(function (o) {
        if (typeof o.finalAmount !== 'number') return;
        const k = monthKey(o.recordedAt || (jobById[o.jobId] && jobById[o.jobId].closedAt));
        if (!k) return;
        byMonth[k] = (byMonth[k] || 0) + o.finalAmount;
      });
      const trend = Object.keys(byMonth).sort().map(function (k) { return { month: k, revenue: round(byMonth[k]) }; });

      return {
        status: amounts.length >= MIN ? 'ok' : 'warming_up',
        sample: { wonJobs: won.length, withAmount: amounts.length },
        totalRevenue: round(sum(amounts)),
        avgTicket: amounts.length ? round(mean(amounts)) : null,
        medianTicket: amounts.length ? round(median(amounts)) : null,
        byService: Object.values(byService).map(function (b) { b.revenue = round(b.revenue); b.avgTicket = round(b.revenue / b.jobs); return b; }).sort(function (a, b) { return b.revenue - a.revenue; }),
        trend: trend
      };
    },

    /** Pricing: win/loss, estimate accuracy, performance by service type. */
    async pricing() {
      const m = await load();
      const wonLost = m.outcomes.filter(function (o) { return o.result === 'won' || o.result === 'lost'; });
      const won = wonLost.filter(function (o) { return o.result === 'won'; }).length;
      const jobById = {}; m.jobs.forEach(function (j) { jobById[j.id] = j; });

      // Estimate accuracy: midpoint of estimates vs final amount.
      const accs = [];
      m.outcomes.forEach(function (o) {
        if (typeof o.estimateAccuracy === 'number') { accs.push(o.estimateAccuracy); return; }
        const job = jobById[o.jobId];
        if (!job || typeof o.finalAmount !== 'number' || o.finalAmount <= 0) return;
        const mids = (job.estimates || []).map(function (e) { return quoteMidpoint(e.estimatedQuoteRange); }).filter(function (n) { return n != null; });
        if (mids.length) accs.push(Math.max(0, 1 - Math.abs(mean(mids) - o.finalAmount) / o.finalAmount));
      });

      // Win rate + loss reasons by service type.
      const byService = {};
      wonLost.forEach(function (o) {
        const job = jobById[o.jobId];
        const s = job ? jobService(job) : 'unspecified';
        const b = byService[s] || (byService[s] = { service: s, won: 0, lost: 0, lossReasons: {} });
        if (o.result === 'won') b.won++; else {
          b.lost++;
          const r = (o.reason || o.lossReason || 'unspecified');
          b.lossReasons[r] = (b.lossReasons[r] || 0) + 1;
        }
      });

      return {
        status: wonLost.length >= MIN ? 'ok' : 'warming_up',
        sample: { decided: wonLost.length, withEstimateAccuracy: accs.length },
        winRate: wonLost.length ? round(won / wonLost.length, 3) : null,
        avgEstimateAccuracy: accs.length ? round(mean(accs), 3) : null,
        byService: Object.values(byService).map(function (b) {
          const wl = b.won + b.lost; b.winRate = wl ? round(b.won / wl, 3) : null;
          b.lossReasons = Object.keys(b.lossReasons).map(function (k) { return { reason: k, count: b.lossReasons[k] }; }).sort(function (a, c) { return c.count - a.count; });
          return b;
        }).sort(function (a, b) { return (b.won + b.lost) - (a.won + a.lost); })
      };
    },

    /** Customer: repeat rate, referral sources, review sentiment. */
    async customer() {
      const m = await load();
      const jobsByCustomer = {};
      m.jobs.forEach(function (j) { (jobsByCustomer[j.customerId] = jobsByCustomer[j.customerId] || []).push(j); });
      const customerIds = Object.keys(jobsByCustomer);
      const repeat = customerIds.filter(function (id) { return jobsByCustomer[id].length > 1; }).length;

      const bySource = {};
      m.customers.forEach(function (c) { const s = c.source || 'unknown'; bySource[s] = (bySource[s] || 0) + 1; });
      const referrals = (bySource.referral || 0) + (bySource.referrals || 0);

      // Review sentiment: prefer a numeric rating; else count text presence.
      const ratings = m.reviews.map(function (r) { return typeof r.rating === 'number' ? r.rating : null; }).filter(function (n) { return n != null; });
      const positive = m.reviews.filter(function (r) { return (typeof r.rating === 'number' && r.rating >= 4) || r.sentiment === 'positive'; }).length;
      const negative = m.reviews.filter(function (r) { return (typeof r.rating === 'number' && r.rating <= 2) || r.sentiment === 'negative'; }).length;

      return {
        status: customerIds.length >= MIN ? 'ok' : 'warming_up',
        sample: { customers: m.customers.length, withJobs: customerIds.length, reviews: m.reviews.length },
        repeatCustomers: repeat,
        repeatRate: customerIds.length ? round(repeat / customerIds.length, 3) : null,
        referralCount: referrals,
        bySource: Object.keys(bySource).map(function (k) { return { source: k, count: bySource[k] }; }).sort(function (a, b) { return b.count - a.count; }),
        reviews: { count: m.reviews.length, avgRating: ratings.length ? round(mean(ratings), 2) : null, positive: positive, negative: negative }
      };
    },

    /** Operations: durations, callbacks, rework, open vs closed. */
    async operations() {
      const m = await load();
      const closed = m.jobs.filter(function (j) { return j.currentState === 'CLOSED' || j.closedAt; });
      const open = m.jobs.length - closed.length;
      const callbacks = m.outcomes.filter(function (o) { return o.result === 'callback' || o.callback === true; }).length;
      const rework = m.outcomes.filter(function (o) { return o.result === 'rework' || o.rework === true; }).length;

      // Estimated time per job (from estimates) — real planned durations.
      const times = [];
      m.jobs.forEach(function (j) {
        (j.estimates || []).forEach(function (e) { if (typeof e.estimatedTimeMins === 'number') times.push(e.estimatedTimeMins); });
      });

      return {
        status: m.jobs.length >= MIN ? 'ok' : 'warming_up',
        sample: { jobs: m.jobs.length, closed: closed.length },
        openJobs: open, closedJobs: closed.length,
        callbacks: callbacks, rework: rework,
        callbackRate: closed.length ? round(callbacks / closed.length, 3) : null,
        avgEstimatedJobMins: times.length ? round(mean(times)) : null
      };
    },

    /** Marketing: per-channel close rate & volume (reuses AAA_MARKETING when present). */
    async marketing() {
      let channels = [];
      if (global.AAA_MARKETING && global.AAA_MARKETING.channelStats) {
        channels = await global.AAA_MARKETING.channelStats();
      }
      const totalJobs = channels.reduce(function (a, c) { return a + (c.jobs || 0); }, 0);
      return {
        status: channels.length >= 2 ? 'ok' : 'warming_up',
        note: 'Live ad-platform (Google Ads / GBP / SEO) data is not yet wired in; channels are derived from lead source on real jobs.',
        sample: { channels: channels.length, jobs: totalJobs },
        channels: channels
      };
    },

    /** AI: the agents' own track record — low-confidence count, calibration, per-agent. */
    async ai() {
      const m = await load();
      const dec = m.decisions;
      const withConf = dec.filter(function (d) { return typeof d.confidence === 'number'; });
      const lowConf = withConf.filter(function (d) { return d.confidence < 50; }).length;
      const scored = dec.filter(function (d) { return typeof d.score === 'number'; });

      let supervisor = null;
      if (global.AAA_SUPERVISOR && global.AAA_SUPERVISOR.metrics) {
        try { supervisor = await global.AAA_SUPERVISOR.metrics(); } catch (_) {}
      }

      const perAgent = {};
      dec.forEach(function (d) {
        const a = d.agent || 'unknown';
        const p = perAgent[a] || (perAgent[a] = { agent: a, decisions: 0, confs: [], scores: [] });
        p.decisions++;
        if (typeof d.confidence === 'number') p.confs.push(d.confidence);
        if (typeof d.score === 'number') p.scores.push(d.score);
      });

      return {
        status: dec.length >= MIN ? 'ok' : 'warming_up',
        sample: { decisions: dec.length, scored: scored.length },
        lowConfidenceCount: lowConf,
        avgConfidence: withConf.length ? round(mean(withConf.map(function (d) { return d.confidence; })), 1) : null,
        avgCalibration: scored.length ? round(mean(scored.map(function (d) { return d.score; })), 3) : null,
        perAgent: Object.values(perAgent).map(function (p) {
          p.avgConfidence = p.confs.length ? round(mean(p.confs), 1) : null;
          p.avgCalibration = p.scores.length ? round(mean(p.scores), 3) : null;
          p.scoredCount = p.scores.length; delete p.confs; delete p.scores; return p;
        }).sort(function (a, b) { return b.decisions - a.decisions; }),
        supervisorMetrics: supervisor && supervisor.ok ? supervisor : null
      };
    },

    /** Run the collector for a given team id. */
    async forTeam(teamId) {
      if (typeof this[teamId] === 'function') return this[teamId]();
      return { status: 'warming_up', error: 'NO_COLLECTOR', sample: {} };
    },

    /** All domains at once — used by the executive dashboard health row. */
    async all() {
      return {
        revenue: await this.revenue(), pricing: await this.pricing(),
        customer: await this.customer(), operations: await this.operations(),
        marketing: await this.marketing(), ai: await this.ai()
      };
    }
  };

  function median(arr) {
    const a = arr.slice().sort(function (x, y) { return x - y; });
    const n = a.length; if (!n) return null;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  global.AAA_INTEL_COLLECTORS = Collectors;
})(typeof window !== 'undefined' ? window : this);
