/*
 * AAA Learning Fabric — shared memory that turns every won/lost job into a
 * forward-looking recommendation, with NO hardcoded rules.
 *
 * Where P9 scores the AGENTS, the Learning Fabric remembers the JOBS: it builds
 * a job_memory from resolved quotes (service / zip / lead source / price band /
 * margin / outcome / follow-up timing), then answers two questions for a NEW
 * job from that memory alone:
 *   recall(context)       → "what happened with jobs like this?" (win rate,
 *                            margin, sample, timing)
 *   recommendFor(context) → an explainable advisory recommendation grounded in
 *                            the recalled evidence (cites sample + rates), never
 *                            applied automatically.
 * insights() surfaces the strongest learnings (best service, best-margin
 * neighborhood, best lead source, ideal follow-up window).
 *
 * Everything is learned from data — change the data, the recommendations change.
 * Owner-only; advisory; mutates no business record. Deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const MEMORY = 'job_memory';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function quotes() { return global.AAA_QUOTES; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function minSample() { return num(cfg().flag ? cfg().flag('fabricMinSample', 3) : 3) || 3; }

  function priceBand(total) {
    const v = num(total); if (v == null) return 'unknown';
    if (v < 500) return '<$500'; if (v < 1000) return '$500-1k'; if (v < 2500) return '$1k-2.5k'; if (v < 5000) return '$2.5k-5k'; return '$5k+';
  }
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : (q && q.serviceType ? [q.serviceType] : []); return s.length ? s.slice().sort().join(' + ') : 'unspecified'; }
  function isWon(m) { return m.status === 'won'; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

  const Fabric = {
    MEMORY: MEMORY,

    /** Build job memory from resolved quotes (idempotent, deterministic ids). */
    async ingest() {
      const qs = await listQuotes();
      let added = 0;
      for (const q of qs) {
        if (q.status !== 'won' && q.status !== 'lost') continue;
        const qid = q.quoteId || q.id; if (!qid) continue;
        const id = 'mem_' + qid;
        if (await data().get(MEMORY, id)) continue;
        const sentToResolve = (q.sentAt && q.resolvedAt) ? Math.round((Date.parse(q.resolvedAt) - Date.parse(q.sentAt)) / 86400000) : null;
        const rec = {
          id: id, workspaceId: ws(), quoteId: qid, jobId: q.jobId || null, customerId: q.customerId || null,
          serviceType: serviceKey(q), zip: q.zip || 'unknown', leadSource: q.leadSource || 'unknown',
          priceBand: priceBand(q.customerTotal), customerTotal: num(q.customerTotal), marginPct: num(q.marginPct),
          status: q.status, sentToResolveDays: sentToResolve != null && sentToResolve >= 0 ? sentToResolve : null,
          reviewRequested: !!q.reviewRequested, at: q.resolvedAt || nowISO()
        };
        await put(rec); added++;
      }
      return { ok: true, added: added };
    },

    async memory() { return (await data().list(MEMORY)).filter(mine); },

    /** Recall what happened with jobs like this context (AND over provided dims). */
    async recall(context) {
      const c = context || {};
      const all = await this.memory();
      const want = {};
      if (c.serviceType) want.serviceType = Array.isArray(c.serviceType) ? c.serviceType.slice().sort().join(' + ') : c.serviceType;
      if (c.zip) want.zip = c.zip;
      if (c.leadSource) want.leadSource = c.leadSource;
      if (c.priceBand) want.priceBand = c.priceBand; else if (c.customerTotal != null) want.priceBand = priceBand(c.customerTotal);
      const match = all.filter((m) => Object.keys(want).every((k) => m[k] === want[k]));
      const wins = match.filter(isWon), losses = match.filter((m) => m.status === 'lost');
      const winDays = wins.map((m) => m.sentToResolveDays).filter((d) => d != null);
      const lossDays = losses.map((m) => m.sentToResolveDays).filter((d) => d != null);
      const margins = wins.map((m) => m.marginPct).filter((v) => v != null);
      return {
        ok: true, criteria: want, sample: match.length, wins: wins.length, losses: losses.length,
        winRate: match.length ? Math.round((wins.length / match.length) * 100) : null,
        avgMargin: margins.length ? Math.round(mean(margins)) : null,
        avgDaysToWin: winDays.length ? Math.round(mean(winDays) * 10) / 10 : null,
        avgDaysToLoss: lossDays.length ? Math.round(mean(lossDays) * 10) / 10 : null
      };
    },

    /** An explainable forward recommendation for a new job, grounded in memory. */
    async recommendFor(context) {
      const r = await this.recall(context);
      const min = minSample();
      const evidence = { sample: r.sample, winRate: r.winRate, avgMargin: r.avgMargin, criteria: r.criteria };
      if (r.sample < min) return { ok: true, confidence: Math.min(40, r.sample * 12), recommendation: 'Not enough history for this segment yet — handle with standard pricing and capture the outcome to learn.', tips: [], evidence: evidence, basis: r.sample + ' similar job(s)' };
      const tips = [];
      let headline;
      if (r.winRate >= 60) headline = 'Strong segment — prioritize this lead; pricing holds (' + r.winRate + '% close over ' + r.sample + ').';
      else if (r.winRate < 34) headline = 'Weak segment — qualify harder or revisit pricing/positioning (' + r.winRate + '% close over ' + r.sample + ').';
      else headline = 'Average segment — standard handling (' + r.winRate + '% close over ' + r.sample + ').';
      if (r.avgMargin != null) tips.push('Expect ~' + r.avgMargin + '% margin in this segment.');
      if (r.avgDaysToWin != null && (r.avgDaysToLoss == null || r.avgDaysToWin <= r.avgDaysToLoss)) tips.push('Follow up within ' + Math.max(1, Math.ceil(r.avgDaysToWin)) + ' day(s) — wins here close that fast.');
      else if (r.avgDaysToLoss != null && r.avgDaysToWin != null && r.avgDaysToWin > r.avgDaysToLoss) tips.push('Don’t let this sit — losses here dragged to ~' + r.avgDaysToLoss + ' days.');
      const confidence = Math.min(95, 40 + Math.min(40, r.sample * 5) + (r.winRate != null ? Math.round(Math.abs(r.winRate - 50) / 5) : 0));
      return { ok: true, recommendation: headline, tips: tips, confidence: confidence, evidence: evidence, basis: r.sample + ' similar job(s) in memory' };
    },

    /** Top learnings across dimensions (best service / margin zip / lead source / timing). */
    async insights() {
      const all = await this.memory();
      const min = minSample();
      const group = (keyFn) => { const g = {}; all.forEach((m) => { const k = keyFn(m); if (k == null || k === 'unknown' || k === 'unspecified') return; const e = g[k] || (g[k] = { key: k, count: 0, won: 0, margins: [], winDays: [] }); e.count++; if (isWon(m)) { e.won++; if (m.marginPct != null) e.margins.push(m.marginPct); if (m.sentToResolveDays != null) e.winDays.push(m.sentToResolveDays); } }); return Object.keys(g).map((k) => g[k]).filter((e) => e.count >= min); };
      const byWin = (groups) => groups.map((e) => ({ key: e.key, winRate: Math.round((e.won / e.count) * 100), sample: e.count })).sort((a, b) => b.winRate - a.winRate);
      const byMargin = (groups) => groups.map((e) => ({ key: e.key, avgMargin: e.margins.length ? Math.round(mean(e.margins)) : null, sample: e.count })).filter((x) => x.avgMargin != null).sort((a, b) => b.avgMargin - a.avgMargin);
      const svc = byWin(group(serviceKeyOf));
      const zip = byMargin(group((m) => m.zip));
      const lead = byWin(group((m) => m.leadSource));
      const winDaysAll = all.filter(isWon).map((m) => m.sentToResolveDays).filter((d) => d != null);
      return {
        ok: true, memorySize: all.length,
        bestService: svc[0] || null, bestMarginNeighborhood: zip[0] || null, bestLeadSource: lead[0] || null,
        idealFollowUpDays: winDaysAll.length ? Math.max(1, Math.round(mean(winDaysAll))) : null,
        services: svc.slice(0, 6), neighborhoods: zip.slice(0, 6), leadSources: lead.slice(0, 6)
      };
    },

    /** Generate an INTERNAL synthetic scenario via the governed Base model (if
     *  live). Internal-only — never customer-facing. Advisory. */
    async generateScenario(seed, opts) {
      const o = opts || {};
      const router = global.AAA_GOVERNED_MODEL_ROUTER; if (!router) return { ok: false, error: 'NO_MODEL_ROUTER' };
      const res = await router.call({ taskType: 'scenario_generation', input: seed, actor: o.actor || null, origin: o.origin, agent: 'learning_fabric' });
      return { ok: true, advisory: true, internalOnly: true, scenario: res.output ? (res.output.text || null) : null, envelope: res };
    },

    async refresh() { await this.ingest(); return this.insights(); }
  };

  function serviceKeyOf(m) { return m.serviceType; }
  async function listQuotes() { try { if (quotes() && quotes().list) return (await quotes().list()).filter(mine); return (await data().list('quotes')).filter(mine); } catch (_) { return []; } }
  async function put(rec) { await data().put(MEMORY, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(MEMORY, rec.id, rec); } catch (_) {} }

  global.AAA_LEARNING_FABRIC = Fabric;
})(typeof window !== 'undefined' ? window : this);
