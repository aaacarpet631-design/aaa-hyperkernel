/*
 * AAA Owner Copilot — the executive daily intelligence system.
 *
 * One read-only briefing that answers "what requires my attention today?" in
 * seconds, by aggregating every system built so far: revenue, open quotes,
 * follow-ups due, jobs at risk, cash-flow alerts, KPI changes, agent
 * recommendations, council decisions awaiting approval, learning proposals
 * awaiting review, and critical operational issues. Each section is source-linked
 * and explainable; the briefing is governance-aware (it surfaces decisions, it
 * makes none). It changes nothing — it only tells the owner where to look.
 *
 *   briefing()          the full morning briefing (persistable as a daily record)
 *   attentionSummary()  the 60-second answer: headline + count + top priorities
 *
 * Owner-only; deterministic; null-tolerant (a missing module just omits its
 * section). Reuses Financial Intelligence, AI Ops, Proposal Engine, Reliability,
 * the councils, governance, and quotes.
 */
;(function (global) {
  'use strict';

  const BRIEFINGS = 'owner_briefings';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function quotes() { return global.AAA_QUOTES; }
  function fin() { return global.AAA_FINANCIAL_INTELLIGENCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }
  function section(count, items, source, explain) { return { count: count, items: items || [], source: source, explain: explain || '' }; }

  const Copilot = {
    BRIEFINGS: BRIEFINGS,

    /** The full daily briefing. Read-only aggregation; source-linked; explainable. */
    async briefing() {
      const now = nowMs();
      const policy = await activePolicy();
      const allQuotes = await quiet(() => quotes() && quotes().list ? quotes().list() : data().list('quotes'), []);
      const ours = allQuotes.filter(mine);

      // ---- revenue ----
      const pays = await quiet(() => data().list('payments'), []);
      const yStart = startOfDay(now) - 86400000, yEnd = startOfDay(now);
      const mStart = startOfMonth(now);
      const sumPay = (lo, hi) => pays.filter(mine).reduce((s, p) => { const t = Date.parse(p.receivedAt || p.createdAt || ''); return (isFinite(t) && t >= lo && t < hi) ? s + num(p.amount) : s; }, 0);
      const revenueYesterday = round(sumPay(yStart, yEnd));
      const revenueThisMonth = round(sumPay(mStart, now + 1));

      // ---- open quotes + follow-ups due + jobs at risk ----
      const open = ours.filter((q) => ['sent', 'ready', 'reviewed', 'follow_up_due'].indexOf(q.status) !== -1);
      const followUpsDue = open.filter((q) => q.status === 'sent' && q.sentAt && (now - Date.parse(q.sentAt)) > num(policy.followUpDays) * 86400000);
      const jobsAtRisk = ours.filter((q) => (q.status !== 'won' && q.status !== 'lost') && (num(q.risk) >= 60 || (q.sentAt && (now - Date.parse(q.sentAt)) > num(policy.followUpDays) * 2 * 86400000)));

      // ---- cash-flow alerts ----
      const anomalies = await quiet(async () => fin() && fin().anomalies ? (await fin().anomalies()).anomalies : [], []);
      const ar = await quiet(async () => fin() && fin().arAging ? await fin().arAging(now) : null, null);
      const cashAlerts = (anomalies || []).map((a) => ({ kind: a.kind, month: a.month, value: a.value }));
      if (ar && ar.overdue > 0) cashAlerts.push({ kind: 'overdue_ar', value: ar.overdue });

      // ---- KPI changes (last two financial snapshots) ----
      const finSnaps = await quiet(async () => fin() && fin().snapshots ? await fin().snapshots() : [], []);
      let kpiChanges = [];
      if (finSnaps.length >= 2) { const a = finSnaps[0], b = finSnaps[1]; if (a.netMargin != null && b.netMargin != null && a.netMargin !== b.netMargin) kpiChanges.push({ kpi: 'net margin', from: b.netMargin, to: a.netMargin }); if (a.dso != null && b.dso != null && a.dso !== b.dso) kpiChanges.push({ kpi: 'DSO', from: b.dso, to: a.dso }); }

      // ---- decisions awaiting the owner (governance-aware) ----
      const pricingOpen = await quiet(async () => { if (!global.AAA_PRICING_OPTIMIZER || !global.AAA_PRICING_OPTIMIZER.analyze) return 0; const a = await global.AAA_PRICING_OPTIMIZER.analyze(); return (a.recommendations || []).filter((r) => (r.status || 'open') === 'open').length; }, 0);
      const councilPending = await quiet(async () => { if (!global.AAA_AGENT_COUNCIL) return 0; return (await global.AAA_AGENT_COUNCIL.list()).filter((s) => s.status === 'pending_approval').length; }, 0);
      const execPending = await quiet(async () => { if (!global.AAA_EXECUTIVE_COUNCIL) return 0; return (await global.AAA_EXECUTIVE_COUNCIL.list('pending_approval')).length; }, 0);
      const proposalsPending = await quiet(async () => { if (!global.AAA_PROPOSAL_ENGINE) return []; return await global.AAA_PROPOSAL_ENGINE.list('pending'); }, []);
      const incidents = await quiet(async () => { if (!global.AAA_RELIABILITY) return []; return await global.AAA_RELIABILITY.incidents('open'); }, []);
      const criticalIssues = incidents.filter((i) => i.severity === 'crit');

      const sections = {
        revenueYesterday: section(revenueYesterday, [], 'payments', 'Payments received yesterday.'),
        revenueThisMonth: section(revenueThisMonth, [], 'payments', 'Payments received this month to date.'),
        openQuotes: section(open.length, open.slice(0, 5).map((q) => ({ id: q.quoteId || q.id, customer: q.customerName || null, status: q.status })), 'quotes', 'Quotes out and not yet won/lost.'),
        followUpsDue: section(followUpsDue.length, followUpsDue.slice(0, 5).map((q) => ({ id: q.quoteId || q.id, customer: q.customerName || null })), 'quotes', 'Sent quotes past the ' + policy.followUpDays + '-day follow-up window.'),
        jobsAtRisk: section(jobsAtRisk.length, jobsAtRisk.slice(0, 5).map((q) => ({ id: q.quoteId || q.id, risk: q.risk })), 'quotes', 'High-risk or long-stalled opportunities.'),
        cashFlowAlerts: section(cashAlerts.length, cashAlerts, 'financial_intelligence', 'Expense spikes, revenue drops, or overdue A/R.'),
        kpiChanges: section(kpiChanges.length, kpiChanges, 'financial_snapshots', 'Notable movement since the last snapshot.'),
        agentRecommendations: section(pricingOpen, [], 'pricing_recommendations', 'Pricing recommendations awaiting your review.'),
        councilDecisions: section(councilPending + execPending, [], 'council_sessions/executive_reviews', 'Council + executive reviews awaiting approval.'),
        learningProposals: section(proposalsPending.length, proposalsPending.slice(0, 5).map((p) => ({ id: p.id, title: p.title })), 'proposals', 'Governed improvement proposals awaiting review.'),
        criticalIssues: section(criticalIssues.length, criticalIssues.map((i) => ({ id: i.id, title: i.title })), 'incidents', 'Critical reliability incidents.')
      };

      // Top priorities (governance-aware ranking).
      const priorities = [];
      criticalIssues.forEach((i) => priorities.push({ kind: 'incident', label: i.title, weight: 5, open: 'AAA_RELIABILITY_UI' }));
      if (execPending) priorities.push({ kind: 'executive', label: execPending + ' executive review(s) awaiting approval', weight: 4, open: 'AAA_EXECUTIVE_COUNCIL_UI' });
      if (proposalsPending.length) priorities.push({ kind: 'proposal', label: proposalsPending.length + ' learning proposal(s) to review', weight: 4, open: 'AAA_PROPOSAL_REVIEW_UI' });
      (cashAlerts.length ? [1] : []).forEach(() => priorities.push({ kind: 'cash', label: cashAlerts.length + ' cash-flow alert(s)', weight: 4, open: 'AAA_FINANCIAL_INTELLIGENCE_UI' }));
      if (followUpsDue.length) priorities.push({ kind: 'followup', label: followUpsDue.length + ' follow-up(s) due', weight: 3, open: 'AAA_TRANSPORT_DASHBOARD_UI' });
      if (councilPending) priorities.push({ kind: 'council', label: councilPending + ' council session(s) to review', weight: 3, open: 'AAA_AGENT_COUNCIL_UI' });
      if (jobsAtRisk.length) priorities.push({ kind: 'risk', label: jobsAtRisk.length + ' job(s) at risk', weight: 3, open: null });
      if (pricingOpen) priorities.push({ kind: 'pricing', label: pricingOpen + ' pricing recommendation(s)', weight: 2, open: 'AAA_PRICING_OPTIMIZER_UI' });
      priorities.sort((a, b) => b.weight - a.weight);

      const attention = priorities.reduce((s, p) => s + 1, 0);
      const headline = attention === 0 ? 'All clear — nothing needs you this morning.' : (priorities[0].label + (attention > 1 ? ' · +' + (attention - 1) + ' more' : '') + (criticalIssues.length ? ' · ⚠ ' + criticalIssues.length + ' critical' : ''));

      return {
        ok: true, date: nowISO().slice(0, 10), generatedAt: nowISO(),
        headline: headline, attentionItems: attention,
        sections: sections, priorities: priorities.slice(0, 8),
        note: 'Read-only intelligence — it surfaces decisions, it makes none. Every number links to its source.'
      };
    },

    /** The 60-second answer: headline + total + the top 3 things to do. */
    async attentionSummary() {
      const b = await this.briefing();
      return { ok: true, headline: b.headline, attentionItems: b.attentionItems, top: b.priorities.slice(0, 3), revenueThisMonth: b.sections.revenueThisMonth.count, date: b.date };
    },

    /** Persist today's briefing as a dated record (idempotent per day). */
    async generate() {
      const b = await this.briefing();
      const id = 'brief_' + ws() + '_' + b.date;
      const rec = { id: id, workspaceId: ws(), date: b.date, headline: b.headline, attentionItems: b.attentionItems, sections: b.sections, priorities: b.priorities, createdAt: nowISO() };
      await put(rec);
      return { ok: true, briefing: rec };
    },
    async list(limit) { return (await data().list(BRIEFINGS)).filter(mine).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, limit || 14); }
  };

  function startOfDay(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function startOfMonth(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  async function activePolicy() {
    const dflt = { followUpDays: 3, marginFloor: 25, reviewSlaHours: 48 };
    try { if (global.AAA_GOVERNANCE && global.AAA_GOVERNANCE.getActive) { const v = await global.AAA_GOVERNANCE.getActive('policy', 'sales_sla'); if (v && v.content) { const c = typeof v.content === 'string' ? JSON.parse(v.content) : v.content; return Object.assign({}, dflt, c); } } } catch (_) {}
    return dflt;
  }
  async function put(rec) { await data().put(BRIEFINGS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(BRIEFINGS, rec.id, rec); } catch (_) {} }

  global.AAA_OWNER_COPILOT = Copilot;
})(typeof window !== 'undefined' ? window : this);
