/*
 * AAA AI Operations Command Center — mission control for the whole AI org.
 *
 * The capstone aggregator: it doesn't add a new model, it UNIFIES the ones built
 * across P2–P13 into one operator view —
 *   - a single ACTION QUEUE of everything awaiting a human decision (pricing
 *     recommendations, council sessions, executive reviews, calibration
 *     proposals, erasure requests, messages to approve, open incidents),
 *   - a SUMMARY of system health, agent activity, governance, and event volume,
 *   - a DIGEST (a short owner briefing of the top priorities).
 *
 * Pure read aggregation over existing seams — it adds no collection, mutates
 * nothing, and acts on nothing (each item deep-links to the module that owns the
 * decision). Every source is guarded, so a missing module just contributes
 * nothing. Owner-only (the UI gates it). Deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  async function quiet(fn, dflt) { try { const r = await fn(); return r == null ? dflt : r; } catch (_) { return dflt; } }
  function arr(v) { return Array.isArray(v) ? v : []; }

  const PRIORITY = { incident: 5, executive: 4, council: 3, calibration: 3, privacy: 4, pricing: 2, transport: 2 };
  function item(kind, id, title, summary, openModule, extra) { return Object.assign({ kind: kind, id: id, title: title, summary: summary || '', priority: PRIORITY[kind] || 1, openModule: openModule || null }, extra || {}); }

  const Ops = {
    /** Everything awaiting a human decision, most urgent first. */
    async actionQueue() {
      const q = [];

      // Pricing recommendations still open (unreviewed).
      const pricing = await quiet(async () => (global.AAA_PRICING_OPTIMIZER && global.AAA_PRICING_OPTIMIZER.analyze) ? await global.AAA_PRICING_OPTIMIZER.analyze() : null, null);
      arr(pricing && pricing.recommendations).filter((r) => (r.status || 'open') === 'open').slice(0, 25).forEach((r) => q.push(item('pricing', r.id, r.title, 'confidence ' + (r.adjustedConfidence != null ? r.adjustedConfidence : r.confidence) + ' · risk ' + r.risk, 'AAA_PRICING_OPTIMIZER_UI')));

      // Council sessions pending approval.
      const sessions = await quiet(async () => (global.AAA_AGENT_COUNCIL && global.AAA_AGENT_COUNCIL.list) ? await global.AAA_AGENT_COUNCIL.list() : null, null);
      arr(sessions).filter((s) => s.status === 'pending_approval').forEach((s) => q.push(item('council', s.id, 'Council: ' + (s.customerName || s.quoteId || s.id), s.decision + ' · disagreement ' + s.disagreement + '%', 'AAA_AGENT_COUNCIL_UI')));

      // Executive reviews pending approval.
      const execs = await quiet(async () => (global.AAA_EXECUTIVE_COUNCIL && global.AAA_EXECUTIVE_COUNCIL.list) ? await global.AAA_EXECUTIVE_COUNCIL.list('pending_approval') : null, null);
      arr(execs).forEach((r) => q.push(item('executive', r.id, 'Exec: ' + r.title, r.decision + ' · risk ' + r.riskScore + ' · ' + (r.objections ? r.objections.length : 0) + ' objection(s)', 'AAA_EXECUTIVE_COUNCIL_UI')));

      // Calibration proposals pending.
      const cal = await quiet(async () => (global.AAA_CALIBRATION_REGISTRY && global.AAA_CALIBRATION_REGISTRY.listProposals) ? await global.AAA_CALIBRATION_REGISTRY.listProposals('pending') : null, null);
      arr(cal).forEach((p) => q.push(item('calibration', p.id, 'Calibration: ' + p.agent, 'confidence bias ' + p.confidenceBias, 'AAA_CALIBRATION_UI')));

      // Erasure requests pending.
      const erase = await quiet(async () => (global.AAA_PRIVACY && global.AAA_PRIVACY.listRequests) ? await global.AAA_PRIVACY.listRequests('pending') : null, null);
      arr(erase).forEach((r) => q.push(item('privacy', r.id, 'Erasure: ' + r.subjectType + ' ' + r.subjectId, r.reason || 'right to be forgotten', 'AAA_PRIVACY_DASHBOARD_UI')));

      // Messages awaiting approval.
      const msgs = await quiet(async () => (global.AAA_TRANSPORT && global.AAA_TRANSPORT.pendingApproval) ? await global.AAA_TRANSPORT.pendingApproval() : null, null);
      arr(msgs).slice(0, 25).forEach((m) => q.push(item('transport', m.id, 'Message: ' + (m.category || m.templateId), (m.channel || '') + ' → ' + m.to, 'AAA_TRANSPORT_DASHBOARD_UI')));

      // Open reliability incidents.
      const incidents = await quiet(async () => (global.AAA_RELIABILITY && global.AAA_RELIABILITY.incidents) ? await global.AAA_RELIABILITY.incidents('open') : null, null);
      arr(incidents).forEach((i) => q.push(item('incident', i.id, i.title, 'since ' + (i.firstSeenAt || ''), 'AAA_RELIABILITY_UI', { severity: i.severity })));

      return q.sort((a, b) => b.priority - a.priority || String(a.kind).localeCompare(String(b.kind)));
    },

    /** A counts + health + activity summary across the org. */
    async summary() {
      const queue = await this.actionQueue();
      const byKind = {}; queue.forEach((x) => { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
      const health = await quiet(async () => (global.AAA_RELIABILITY && global.AAA_RELIABILITY.health) ? await global.AAA_RELIABILITY.health() : null, null);
      const decisions = await quiet(async () => data() ? (await data().list('agent_decisions')) : [], []);
      const activeVersions = await quiet(async () => (global.AAA_GOVERNANCE && global.AAA_GOVERNANCE.listActive) ? (await global.AAA_GOVERNANCE.listActive()).length : 0, 0);
      const events = await quiet(async () => (global.AAA_EVENT_BUS && global.AAA_EVENT_BUS.analytics) ? (await global.AAA_EVENT_BUS.analytics()).total : 0, 0);
      const scoreboard = await quiet(async () => (global.AAA_OUTCOME_INTELLIGENCE && global.AAA_OUTCOME_INTELLIGENCE.scoreboard) ? await global.AAA_OUTCOME_INTELLIGENCE.scoreboard() : [], []);
      return {
        ok: true, pendingDecisions: queue.length, byKind: byKind,
        health: health ? { status: health.status, score: health.score } : null,
        agentActivity: { decisions: arr(decisions).length, scoredAgents: arr(scoreboard).length },
        governance: { activeVersions: activeVersions }, events: { total: events },
        generatedAt: nowISO()
      };
    },

    /** A short owner briefing: headline + the top priorities + health. */
    async digest() {
      const s = await this.summary();
      const queue = await this.actionQueue();
      const critical = queue.filter((x) => x.kind === 'incident' || x.kind === 'executive' || x.kind === 'privacy');
      const headline = s.pendingDecisions === 0
        ? 'All clear — nothing is waiting on you.'
        : s.pendingDecisions + ' decision(s) need you' + (critical.length ? ', ' + critical.length + ' high-priority' : '') + (s.health && s.health.status === 'crit' ? ' · system health CRITICAL' : '') + '.';
      return { ok: true, headline: headline, priorities: queue.slice(0, 5), health: s.health, pendingDecisions: s.pendingDecisions, generatedAt: nowISO() };
    }
  };

  global.AAA_AI_OPS = Ops;
})(typeof window !== 'undefined' ? window : this);
