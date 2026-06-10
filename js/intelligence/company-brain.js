/*
 * AAA Company Brain — Phase 3: a deterministic, evidence-citing business Q&A
 * engine over the stores that already exist.
 *
 * NOT an LLM call. A question is routed to an intent by plain regex, and the
 * answer is COMPOSED from real aggregates: Outcome Learning segments, the
 * Intelligence Collectors' rollups, Quote Store stats, and Financial
 * Intelligence P&L. Every finding carries evidence — which store/method it
 * came from, the metric name, the numeric value, and the underlying sample
 * size — so every claim is traceable back to data. When the data is thin the
 * brain says so in a caveat; it never invents a number.
 *
 *   ask(question)  → { ok, question, intent, answer:{headline, findings, caveat}, confidence }
 *   intents()      → [{ id, example }] for UI hint chips
 *
 * Read-only; deterministic; null-tolerant (a missing store just narrows the
 * answer and is named in the caveat — never a throw).
 */
;(function (global) {
  'use strict';

  // ---- store access (lazy, so a store registered later is still found) ----
  function learn() { return global.AAA_OUTCOME_LEARNING; }
  function collectors() { return global.AAA_INTEL_COLLECTORS; }
  function quotes() { return global.AAA_QUOTES; }
  function fin() { return global.AAA_FINANCIAL_INTELLIGENCE; }
  function data() { return global.AAA_DATA; }

  // ---- tiny pure helpers ---------------------------------------------------
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function pct(x) { return (x == null || !isFinite(Number(x))) ? 'n/a' : Math.round(Number(x) * 100) + '%'; }
  function usd(n) { const v = Math.round(num(n)); return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US'); }
  function cap(s) { s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  async function safe(fn) { try { const r = await fn(); return r == null ? null : r; } catch (_) { return null; } }

  /** Every claim must carry evidence: store/method, metric, value, sample size. */
  function finding(claim, source, metric, value, sample) {
    return { claim: claim, evidence: { source: source, metric: metric, value: value, sample: sample == null ? null : num(sample) } };
  }

  /** Confidence from evidence volume of the PRIMARY finding (first one). */
  function confidenceFor(findings) {
    const s = (findings && findings.length && findings[0].evidence) ? num(findings[0].evidence.sample) : 0;
    return s >= 10 ? 'high' : s >= 3 ? 'medium' : 'low';
  }

  function joinCaveats(parts) { const p = parts.filter(Boolean); return p.length ? p.join(' ') : null; }
  function missingCaveat(missing) { return missing.length ? ('Unavailable right now: ' + missing.join(', ') + ' — answered from the data that IS available.') : null; }

  // ---- intent router (regex, deterministic; first match wins) --------------
  const INTENTS = [
    {
      id: 'revenue_change', example: 'Why did revenue drop last month?',
      match: function (q) { return /\b(revenue|sales)\b/.test(q) && /(drop|rose|rise|ris\w*|fell|fall\w*|down|up|grew|grow\w*|chang\w*|declin\w*|increas\w*|decreas\w*|spike|dip)/.test(q); }
    },
    {
      id: 'why_winning', example: 'Why are stretching jobs winning more?',
      match: function (q) {
        if (/\bwhy\b/.test(q) && /\b(win|winn\w*|won|clos\w*|los\w*)/.test(q)) return true;
        return /\b(winning|closing)\b.*\b(higher|more|better|faster|well)\b/.test(q);
      }
    },
    {
      id: 'most_profitable', example: 'What is most profitable — what should I advertise?',
      match: function (q) { return /profit\w*/.test(q) || /advertis\w*/.test(q) || /\bbest (service|seller|line|margin)\b/.test(q) || /highest margin/.test(q) || /what should (i|we) (sell|push|promote)/.test(q); }
    },
    {
      id: 'pipeline_state', example: "How's the pipeline — where's the money?",
      match: function (q) { return /pipeline/.test(q) || /where('s| is)? the money/.test(q) || /open quotes/.test(q) || /outstanding quotes/.test(q); }
    },
    {
      id: 'win_rate', example: "What's our close rate?",
      match: function (q) { return /(win|close|closing|conversion|hit)[\s-]*rate/.test(q) || /close ratio/.test(q) || /how often do we (win|close)/.test(q); }
    }
  ];

  function route(q) {
    for (let i = 0; i < INTENTS.length; i++) { if (INTENTS[i].match(q)) return INTENTS[i].id; }
    return 'unknown';
  }

  /** Find the byServiceType segment the question is talking about. */
  function findSegment(q, segments) {
    const qWords = q.split(/[^a-z0-9$]+/).filter(function (w) { return w.length >= 4; });
    for (let i = 0; i < (segments || []).length; i++) {
      const seg = segments[i];
      const key = String(seg.key || '').toLowerCase();
      if (key === 'unspecified' || key === 'unknown') continue;
      const toks = key.split(/[^a-z0-9]+/).filter(function (t) { return t.length >= 3; });
      const hit = toks.some(function (t) {
        return q.indexOf(t) !== -1 || qWords.some(function (w) { return w.indexOf(t) === 0 || t.indexOf(w) === 0; });
      });
      if (hit) return seg;
    }
    return null;
  }

  /** Best over-indexing segment (count>=3, winRate clearly above overall). */
  function overIndexing(groups, overallWinRate) {
    if (overallWinRate == null) return null;
    const ok = (groups || []).filter(function (g) {
      return g && g.count >= 3 && g.winRate != null && g.key !== 'unknown' && g.key !== 'unspecified' && g.winRate > overallWinRate + 0.05;
    }).sort(function (a, b) { return b.winRate - a.winRate; });
    return ok.length ? ok[0] : null;
  }

  // ---- per-service month revenue (for revenue_change attribution) ----------
  function monthOf(t) { const d = new Date(t || NaN); return isNaN(d.getTime()) ? null : d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function serviceOf(o, job) {
    const st = o && o.serviceType;
    if (Array.isArray(st) && st.filter(Boolean).length) return st.filter(Boolean).slice().sort().join(' + ');
    if (typeof st === 'string' && st) return st;
    const ests = job && Array.isArray(job.estimates) ? job.estimates : [];
    return (ests[0] && ests[0].type) || (job && job.serviceType) || 'unspecified';
  }
  async function serviceMonthDeltas(fromMonth, toMonth) {
    const d = data();
    if (!d || !d.list) return null;
    const outs = (await d.list('outcomes')) || [];
    const jobsById = {};
    try { ((await d.list('jobs')) || []).forEach(function (j) { if (j && j.id) jobsById[j.id] = j; }); } catch (_) {}
    const per = {};
    outs.forEach(function (o) {
      if (!o || o.result !== 'won' || typeof o.finalAmount !== 'number') return;
      const k = monthOf(o.recordedAt || (jobsById[o.jobId] && jobsById[o.jobId].closedAt));
      if (k !== fromMonth && k !== toMonth) return;
      const svc = serviceOf(o, jobsById[o.jobId]);
      const p = per[svc] || (per[svc] = { service: svc, from: 0, to: 0, n: 0 });
      if (k === fromMonth) p.from += o.finalAmount; else p.to += o.finalAmount;
      p.n++;
    });
    return Object.keys(per).map(function (k) {
      const p = per[k];
      return { service: p.service, from: round2(p.from), to: round2(p.to), delta: round2(p.to - p.from), n: p.n };
    }).sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
  }

  // ---- intent handlers (each returns { headline, findings, caveat }) -------
  async function answerWhyWinning(q) {
    const missing = [], findings = [], caveats = [];
    const agg = (learn() && learn().aggregate) ? await safe(function () { return learn().aggregate(); }) : null;
    if (!agg) {
      missing.push('AAA_OUTCOME_LEARNING');
      return { headline: 'I can\'t see recorded quote outcomes right now, so I can\'t explain wins yet.', findings: findings, caveat: missingCaveat(missing) };
    }
    const ov = agg.overall || {};
    const segs = agg.byServiceType || [];
    const seg = findSegment(q, segs);
    let headline;

    if (seg) {
      const diffPts = (seg.winRate != null && ov.winRate != null) ? Math.round((seg.winRate - ov.winRate) * 100) : null;
      findings.push(finding(
        cap(seg.key) + ' wins ' + pct(seg.winRate) + ' of its ' + seg.count + ' resolved quotes vs ' + pct(ov.winRate) + ' overall' +
          (diffPts != null ? ' (' + (diffPts >= 0 ? '+' : '') + diffPts + ' pts)' : '') + '.',
        'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'winRate', seg.winRate, seg.count));
      if (seg.avgMarginPct != null && ov.avgMarginPct != null) {
        findings.push(finding(
          cap(seg.key) + ' averages ' + seg.avgMarginPct + '% margin vs ' + ov.avgMarginPct + '% across all resolved quotes.',
          'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'avgMarginPct', seg.avgMarginPct, seg.count));
      }
      const ls = overIndexing(agg.byLeadSource, ov.winRate);
      if (ls) findings.push(finding(
        'Lead source "' + ls.key + '" over-indexes: ' + pct(ls.winRate) + ' win rate vs ' + pct(ov.winRate) + ' overall.',
        'AAA_OUTCOME_LEARNING.aggregate().byLeadSource', 'winRate', ls.winRate, ls.count));
      const pb = overIndexing(agg.byPriceBand, ov.winRate);
      if (pb) findings.push(finding(
        'Price band ' + pb.key + ' over-indexes: ' + pct(pb.winRate) + ' win rate vs ' + pct(ov.winRate) + ' overall.',
        'AAA_OUTCOME_LEARNING.aggregate().byPriceBand', 'winRate', pb.winRate, pb.count));

      if (seg.count < 3) {
        caveats.push('Only ' + seg.count + ' recorded outcome' + (seg.count === 1 ? '' : 's') + ' for ' + seg.key + ' — not enough to explain the difference yet.');
        headline = cap(seg.key) + ' shows a ' + pct(seg.winRate) + ' win rate, but the sample is too small to draw a conclusion.';
      } else if (seg.winRate != null && ov.winRate != null && seg.winRate >= ov.winRate) {
        headline = cap(seg.key) + ' closes at ' + pct(seg.winRate) + ' — ' + Math.round((seg.winRate - ov.winRate) * 100) + ' points above the company\'s ' + pct(ov.winRate) + '.';
      } else {
        headline = cap(seg.key) + ' closes at ' + pct(seg.winRate) + ', vs ' + pct(ov.winRate) + ' overall.';
      }
    } else {
      // No service named (or none matches recorded segments): give the honest overall picture.
      if (ov.resolved) {
        findings.push(finding(
          'Across all services the win rate is ' + pct(ov.winRate) + ' over ' + ov.resolved + ' resolved quotes.',
          'AAA_OUTCOME_LEARNING.aggregate().overall', 'winRate', ov.winRate, ov.resolved));
        const best = overIndexing(segs, ov.winRate);
        if (best) findings.push(finding(
          cap(best.key) + ' is the strongest segment: ' + pct(best.winRate) + ' win rate (' + best.count + ' outcomes).',
          'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'winRate', best.winRate, best.count));
        headline = 'I couldn\'t match that question to a recorded service segment — here\'s the overall picture.';
        caveats.push('No recorded outcome segment matches that service yet.');
      } else {
        headline = 'No resolved quote outcomes recorded yet, so there is nothing to compare.';
        caveats.push('Record won/lost outcomes on quotes to unlock this answer.');
      }
    }
    return { headline: headline, findings: findings, caveat: joinCaveats(caveats.concat([missingCaveat(missing)])) };
  }

  async function answerMostProfitable() {
    const missing = [], findings = [], caveats = [];
    const rev = (collectors() && collectors().revenue) ? await safe(function () { return collectors().revenue(); }) : null;
    if (!rev) missing.push('AAA_INTEL_COLLECTORS');
    const agg = (learn() && learn().aggregate) ? await safe(function () { return learn().aggregate(); }) : null;
    if (!agg) missing.push('AAA_OUTCOME_LEARNING');
    let headline = 'Not enough recorded revenue to rank services yet.';

    const byService = (rev && rev.byService) || [];
    if (byService.length) {
      const ranked = byService.slice(); // collectors already sort by revenue desc
      const top = ranked[0];
      const sample = (rev.sample && rev.sample.withAmount) || ranked.reduce(function (s, b) { return s + num(b.jobs); }, 0);
      findings.push(finding(
        'Ranked by realized revenue: ' + ranked.map(function (b) { return b.service + ' (' + usd(b.revenue) + ' from ' + b.jobs + ' job' + (b.jobs === 1 ? '' : 's') + ')'; }).join(', ') + '.',
        'AAA_INTEL_COLLECTORS.revenue().byService', 'revenue', top.revenue, sample));
      findings.push(finding(
        cap(top.service) + ' leads with ' + usd(top.revenue) + ' realized revenue and an average ticket of ' + usd(top.avgTicket) + '.',
        'AAA_INTEL_COLLECTORS.revenue().byService', 'avgTicket', top.avgTicket, top.jobs));
      headline = cap(top.service) + ' is your top earner — ' + usd(top.revenue) + ' realized. That\'s the line to advertise.';
      if (rev.status === 'warming_up') caveats.push('Revenue data is still warming up (only ' + sample + ' priced outcomes) — treat the ranking as early signal.');
    }
    if (agg && agg.byServiceType && agg.byServiceType.length) {
      const withMargin = agg.byServiceType.filter(function (s) { return s.avgMarginPct != null && s.key !== 'unspecified'; })
        .sort(function (a, b) { return b.avgMarginPct - a.avgMarginPct; });
      if (withMargin.length) {
        const m = withMargin[0];
        findings.push(finding(
          'Best margins: ' + m.key + ' at ' + m.avgMarginPct + '% average margin across ' + m.count + ' resolved quotes.',
          'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'avgMarginPct', m.avgMarginPct, m.count));
      }
    }
    const pnl = (fin() && fin().pnl) ? await safe(function () { return fin().pnl(); }) : null;
    if (pnl && pnl.ok && pnl.netMargin != null) {
      findings.push(finding(
        'Company-wide net margin is ' + pnl.netMargin + '% (' + usd(pnl.netProfit) + ' net on ' + usd(pnl.revenue) + ' revenue).',
        'AAA_FINANCIAL_INTELLIGENCE.pnl()', 'netMargin', pnl.netMargin, null));
    }
    if (!findings.length) caveats.push('No won outcomes with amounts recorded yet — close a few jobs and ask again.');
    return { headline: headline, findings: findings, caveat: joinCaveats(caveats.concat([missingCaveat(missing)])) };
  }

  async function answerRevenueChange() {
    const missing = [], findings = [], caveats = [];
    const rev = (collectors() && collectors().revenue) ? await safe(function () { return collectors().revenue(); }) : null;
    if (!rev) missing.push('AAA_INTEL_COLLECTORS');
    const trend = (rev && rev.trend) || [];
    let headline;

    if (trend.length >= 2) {
      const last = trend[trend.length - 1], prev = trend[trend.length - 2];
      const delta = round2(last.revenue - prev.revenue);
      const pctChange = prev.revenue ? Math.round((delta / prev.revenue) * 100) : null;
      const dir = delta >= 0 ? 'rose' : 'fell';
      findings.push(finding(
        'Revenue ' + dir + ' ' + usd(Math.abs(delta)) + (pctChange != null ? ' (' + (delta >= 0 ? '+' : '') + pctChange + '%)' : '') +
          ' from ' + prev.month + ' (' + usd(prev.revenue) + ') to ' + last.month + ' (' + usd(last.revenue) + ').',
        'AAA_INTEL_COLLECTORS.revenue().trend', 'monthlyRevenueDelta', delta, (rev.sample && rev.sample.withAmount) || null));
      headline = 'Revenue ' + dir + ' ' + usd(Math.abs(delta)) + ' in ' + last.month + ' vs ' + prev.month + '.';

      // Attribute the delta by service where the underlying outcomes support it.
      const attr = await safe(function () { return serviceMonthDeltas(prev.month, last.month); });
      if (attr && attr.length) {
        attr.slice(0, 2).forEach(function (a) {
          if (!a.delta) return;
          findings.push(finding(
            cap(a.service) + ' accounts for ' + usd(a.delta) + ' of the change (' + usd(a.from) + ' → ' + usd(a.to) + ' across ' + a.n + ' outcomes).',
            'AAA_DATA.list("outcomes") grouped by service × month', 'serviceRevenueDelta', a.delta, a.n));
        });
        const lead = attr[0];
        if (lead && lead.delta) headline += ' ' + cap(lead.service) + ' drove the largest share (' + usd(lead.delta) + ').';
      } else {
        caveats.push('Per-service attribution unavailable — the underlying outcome records could not be read.');
      }
    } else {
      headline = 'I need at least two months of recorded revenue to explain a change.';
      caveats.push('Only ' + trend.length + ' month' + (trend.length === 1 ? '' : 's') + ' of revenue history recorded so far — not enough to compare.');
      if (rev && typeof rev.totalRevenue === 'number') {
        findings.push(finding(
          'Total realized revenue on record: ' + usd(rev.totalRevenue) + '.',
          'AAA_INTEL_COLLECTORS.revenue()', 'totalRevenue', rev.totalRevenue, (rev.sample && rev.sample.withAmount) || null));
      }
    }
    return { headline: headline, findings: findings, caveat: joinCaveats(caveats.concat([missingCaveat(missing)])) };
  }

  async function answerPipelineState() {
    const missing = [], findings = [], caveats = [];
    const st = (quotes() && quotes().stats) ? await safe(function () { return quotes().stats(); }) : null;
    if (!st) {
      missing.push('AAA_QUOTES');
      return { headline: 'The quote store is unavailable, so I can\'t see the pipeline right now.', findings: findings, caveat: missingCaveat(missing) };
    }
    const c = st.counts || {};
    const openCount = num(c.draft) + num(c.reviewed) + num(c.sent) + num(c.follow_up_due);
    findings.push(finding(
      usd(st.pipelineValue) + ' is open in the pipeline across ' + openCount + ' quote' + (openCount === 1 ? '' : 's') +
        ' (draft ' + num(c.draft) + ', reviewed ' + num(c.reviewed) + ', sent ' + num(c.sent) + ', follow-up due ' + num(c.follow_up_due) + ').',
      'AAA_QUOTES.stats()', 'pipelineValue', st.pipelineValue, st.total));
    if (st.closeRatePct != null) {
      findings.push(finding(
        'Close rate is ' + st.closeRatePct + '% (' + num(c.won) + ' won / ' + (num(c.won) + num(c.lost)) + ' resolved).',
        'AAA_QUOTES.stats()', 'closeRatePct', st.closeRatePct, num(c.won) + num(c.lost)));
    } else {
      caveats.push('No quotes resolved won/lost yet, so there is no close rate to report.');
    }
    findings.push(finding(
      'Won revenue to date: ' + usd(st.wonRevenue) + ' from ' + num(c.won) + ' won quote' + (num(c.won) === 1 ? '' : 's') + '.',
      'AAA_QUOTES.stats()', 'wonRevenue', st.wonRevenue, num(c.won)));
    const headline = usd(st.pipelineValue) + ' open across ' + openCount + ' quotes' +
      (st.closeRatePct != null ? '; you close ' + st.closeRatePct + '% of what resolves.' : '.');
    return { headline: headline, findings: findings, caveat: joinCaveats(caveats.concat([missingCaveat(missing)])) };
  }

  async function answerWinRate() {
    const missing = [], findings = [], caveats = [];
    const agg = (learn() && learn().aggregate) ? await safe(function () { return learn().aggregate(); }) : null;
    if (!agg) missing.push('AAA_OUTCOME_LEARNING');
    let headline = 'No win-rate data recorded yet.';

    if (agg && agg.overall && agg.overall.resolved) {
      const ov = agg.overall;
      findings.push(finding(
        'Overall win rate is ' + pct(ov.winRate) + ' across ' + ov.resolved + ' resolved quotes (' + ov.won + ' won, ' + ov.lost + ' lost).',
        'AAA_OUTCOME_LEARNING.aggregate().overall', 'winRate', ov.winRate, ov.resolved));
      headline = 'You win ' + pct(ov.winRate) + ' of resolved quotes.';
      const segs = (agg.byServiceType || []).filter(function (s) { return s.count >= 3 && s.winRate != null && s.key !== 'unspecified'; });
      if (segs.length) {
        const byRate = segs.slice().sort(function (a, b) { return b.winRate - a.winRate; });
        const best = byRate[0], worst = byRate[byRate.length - 1];
        findings.push(finding(
          'Best segment: ' + best.key + ' at ' + pct(best.winRate) + ' (' + best.count + ' outcomes).',
          'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'winRate', best.winRate, best.count));
        if (worst !== best) findings.push(finding(
          'Weakest segment: ' + worst.key + ' at ' + pct(worst.winRate) + ' (' + worst.count + ' outcomes).',
          'AAA_OUTCOME_LEARNING.aggregate().byServiceType', 'winRate', worst.winRate, worst.count));
      } else {
        caveats.push('No service segment has 3+ resolved outcomes yet, so best/worst segments are withheld.');
      }
    } else if (!missing.length) {
      caveats.push('No resolved quote outcomes recorded yet.');
    }
    // Fall back to the quote store's close rate if outcome learning is missing.
    if (!findings.length) {
      const st = (quotes() && quotes().stats) ? await safe(function () { return quotes().stats(); }) : null;
      if (st && st.closeRatePct != null) {
        const resolved = num(st.counts && st.counts.won) + num(st.counts && st.counts.lost);
        findings.push(finding(
          'Close rate is ' + st.closeRatePct + '% per the quote store (' + resolved + ' resolved quotes).',
          'AAA_QUOTES.stats()', 'closeRatePct', st.closeRatePct, resolved));
        headline = 'You close ' + st.closeRatePct + '% of resolved quotes.';
      } else if (!st && !quotes()) {
        missing.push('AAA_QUOTES');
      }
    }
    return { headline: headline, findings: findings, caveat: joinCaveats(caveats.concat([missingCaveat(missing)])) };
  }

  function answerUnknown() {
    const examples = INTENTS.map(function (i) { return '"' + i.example + '"'; }).join(', ');
    return {
      headline: 'I can answer questions about win rates, profitability, revenue trends, and pipeline — try one of those.',
      findings: [],
      caveat: 'Try for example: ' + examples + '.'
    };
  }

  const HANDLERS = {
    why_winning: answerWhyWinning,
    most_profitable: answerMostProfitable,
    revenue_change: answerRevenueChange,
    pipeline_state: answerPipelineState,
    win_rate: answerWinRate
  };

  const Brain = {
    /** Supported intents + example questions, for UI hint chips. Sync. */
    intents() {
      return INTENTS.map(function (i) { return { id: i.id, example: i.example }; });
    },

    /**
     * Answer a business question deterministically from real store aggregates.
     * Always resolves ok:true with an honest answer — never throws.
     */
    async ask(question) {
      const original = String(question == null ? '' : question);
      const q = original.toLowerCase();
      const intent = route(q);
      let composed;
      if (intent === 'unknown') {
        composed = answerUnknown();
      } else {
        try { composed = await HANDLERS[intent](q); }
        catch (e) {
          composed = { headline: 'I hit a problem reading the data for that question.', findings: [], caveat: 'Internal read error: ' + ((e && e.message) || 'unknown') + '.' };
        }
      }
      const findings = composed.findings || [];
      return {
        ok: true,
        question: original,
        intent: intent,
        answer: { headline: composed.headline || '', findings: findings, caveat: composed.caveat || null },
        confidence: intent === 'unknown' ? 'low' : confidenceFor(findings)
      };
    }
  };

  global.AAA_COMPANY_BRAIN = Brain;
})(typeof window !== 'undefined' ? window : this);
