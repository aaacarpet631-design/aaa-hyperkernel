/*
 * AAA Supervisor Council — a deterministic, visible deliberation of the
 * operational agents over a concrete decision (today: a quote).
 *
 * Seven seats: Estimator, Pricing Optimizer, Risk, Follow-Up, Finance,
 * Marketing — each derives a STANCE (approve / revise / reject) + a confidence
 * from its real data — and the Supervisor chairs: it confidence-weights each
 * vote by the member's track record (AAA_SUPERVISOR), scores the disagreement,
 * and produces ONE advisory recommendation.
 *
 * Governance: the council only RECOMMENDS. Its decision is `pending_approval`
 * until a person acts on it through the gateway (REVIEW_COUNCIL, human-only +
 * audited). It changes no price, quote, or customer record. Every session is
 * logged as a prediction (agent_decisions) so the Prediction Ledger + Supervisor
 * score the council itself over time. Owner-only. Null-tolerant throughout.
 */
;(function (global) {
  'use strict';

  const SESSIONS = 'council_sessions';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function quotes() { return global.AAA_QUOTES; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function supervisor() { return global.AAA_SUPERVISOR; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function stanceBy(score, hiApprove, hiRevise, lowerIsBetter) {
    // returns 'approve' | 'revise' | 'reject' given a score and two thresholds
    if (lowerIsBetter) return score < hiApprove ? 'approve' : score < hiRevise ? 'revise' : 'reject';
    return score >= hiApprove ? 'approve' : score >= hiRevise ? 'revise' : 'reject';
  }
  const ABSTAIN = { stance: 'abstain', confidence: 0, concern: null };

  // Each seat reads its slice of the context and returns a position.
  const MEMBERS = [
    { id: 'estimator', title: 'Estimator', fn: (c) => {
      const e = c.estimator; if (!e || e.confidence == null) return ABSTAIN;
      return { stance: stanceBy(e.confidence, 70, 50, false), confidence: clamp(num(e.confidence), 0, 100), concern: (e.severity === 'high' ? 'low estimate confidence on a high-risk job' : null) };
    } },
    { id: 'pricing_optimizer', title: 'Pricing Optimizer', fn: (c) => {
      const o = c.optimizer; if (!o || o.winRate == null) return ABSTAIN;
      return { stance: stanceBy(o.winRate, 0.6, 0.34, false), confidence: clamp(Math.round(50 + Math.abs(o.winRate - 0.5) * 80), 30, 95), concern: (o.winRate < 0.34 ? 'weak win rate for ' + (o.segmentKey || 'this segment') : null) };
    } },
    { id: 'risk', title: 'Risk', fn: (c) => {
      const r = c.risk; if (!r || r.score == null) return ABSTAIN;
      return { stance: stanceBy(num(r.score), 30, 60, true), confidence: clamp(100 - num(r.score), 20, 95), concern: (r.score >= 60 ? 'high job risk — verify scope' : null) };
    } },
    { id: 'follow_up', title: 'Follow-Up', fn: (c) => {
      const f = c.followup; if (!f) return ABSTAIN;
      if (f.status === 'sent' && num(f.sentDaysAgo) > 3) return { stance: 'revise', confidence: 60, concern: 'sent ' + Math.round(num(f.sentDaysAgo)) + 'd ago with no follow-up' };
      return { stance: 'approve', confidence: 45, concern: null };
    } },
    { id: 'finance', title: 'Finance', fn: (c) => {
      const f = c.finance; if (!f || f.marginPct == null) return ABSTAIN;
      const floor = num(f.marginFloor) || 25; const m = num(f.marginPct);
      return { stance: (m >= floor ? 'approve' : m >= floor * 0.6 ? 'revise' : 'reject'), confidence: (m >= floor ? 80 : 65), concern: (m < floor ? 'margin ' + m + '% below the ' + floor + '% floor' : null) };
    } },
    { id: 'marketing', title: 'Marketing', fn: (c) => {
      const m = c.marketing; if (!m || m.winRate == null) return ABSTAIN;
      return { stance: stanceBy(m.winRate, 0.6, 0.34, false), confidence: clamp(Math.round(50 + Math.abs(m.winRate - 0.5) * 80), 30, 95), concern: (m.winRate < 0.34 ? 'low-converting lead source (' + (m.leadSource || 'unknown') + ')' : null) };
    } }
  ];

  const Council = {
    MEMBERS: MEMBERS.map((m) => ({ id: m.id, title: m.title })),

    /**
     * Pure deliberation over a context. Confidence-weighted voting + disagreement
     * scoring. @param weights map of memberId → trackScore (0..1), default 0.5.
     */
    deliberate(ctx, opts) {
      const o = opts || {};
      const weights = o.weights || {};
      const positions = MEMBERS.map((m) => {
        let p; try { p = m.fn(ctx || {}) || ABSTAIN; } catch (_) { p = ABSTAIN; }
        const trackScore = weights[m.id] != null ? clamp(num(weights[m.id]), 0, 1) : 0.5;
        const voteWeight = p.stance === 'abstain' ? 0 : round((num(p.confidence) / 100) * (0.5 + trackScore));
        return { id: m.id, title: m.title, stance: p.stance, confidence: num(p.confidence), concern: p.concern || null, trackScore: trackScore, voteWeight: voteWeight };
      });
      const voting = positions.filter((p) => p.stance !== 'abstain');
      const tally = { approve: 0, revise: 0, reject: 0 };
      voting.forEach((p) => { tally[p.stance] = round((tally[p.stance] || 0) + p.voteWeight); });
      const total = tally.approve + tally.revise + tally.reject;

      let decision = 'revise', top = -1;
      ['reject', 'revise', 'approve'].forEach((s) => { if (tally[s] > top) { top = tally[s]; decision = s; } }); // ties favor the more cautious (reject>revise>approve order ensures cautious wins ties)
      if (!voting.length) decision = 'no_quorum';

      const majorityCount = voting.filter((p) => p.stance === decision).length;
      const disagreement = voting.length ? Math.round((1 - majorityCount / voting.length) * 100) : 0;
      let decisionConfidence = total > 0 ? Math.round((top / total) * 100) : 0;

      // Cautious rule: the council will not APPROVE a badly-split room — high
      // disagreement demotes an approve to a revise (a person should look closer).
      const splitThreshold = num(o.splitThreshold != null ? o.splitThreshold : 40);
      let downgraded = false;
      if (decision === 'approve' && disagreement >= splitThreshold) { decision = 'revise'; downgraded = true; decisionConfidence = Math.round(decisionConfidence * (1 - disagreement / 100)); }

      return {
        decision: decision, decisionConfidence: decisionConfidence, disagreement: disagreement, downgraded: downgraded,
        votingCount: voting.length, abstained: positions.length - voting.length,
        tally: { approve: round(tally.approve), revise: round(tally.revise), reject: round(tally.reject) },
        positions: positions,
        topConcerns: voting.map((p) => p.concern).filter(Boolean).slice(0, 5),
        needsOwnerApproval: true
      };
    },

    /** Convene the council on a quote: gather signals, deliberate, persist, log a prediction. */
    async conveneOnQuote(quoteId, opts) {
      const o = opts || {};
      if (!quotes()) return { ok: false, error: 'NO_QUOTES' };
      const q = await quotes().get(quoteId);
      if (!q) return { ok: false, error: 'QUOTE_NOT_FOUND' };

      // Segment win rates (optional — abstain if no history).
      let leadWin = null, serviceWin = null, serviceKey = null;
      try {
        if (learning()) {
          const agg = await learning().aggregate();
          const ls = (agg.byLeadSource || []).find((g) => g.key === (q.leadSource || 'unknown'));
          leadWin = ls ? ls.winRate : null;
          const svc = (agg.byServiceType || []).find((g) => g.count >= 1 && Array.isArray(q.serviceType) && g.key === q.serviceType.slice().sort().join(' + '));
          serviceWin = svc ? svc.winRate : null; serviceKey = svc ? svc.key : (Array.isArray(q.serviceType) ? q.serviceType.join(' + ') : null);
        }
      } catch (_) {}

      const ctx = {
        type: 'quote', quoteId: q.quoteId || q.id, jobId: q.jobId || null, customerName: q.customerName || null,
        estimator: { confidence: q.confidence, risk: q.risk, severity: q.severity },
        finance: { marginPct: q.marginPct, marginFloor: num(cfg().flag && cfg().flag('councilMarginFloor', 25)) || 25 },
        risk: { score: q.risk },
        optimizer: { segmentKey: serviceKey, winRate: serviceWin },
        marketing: { leadSource: q.leadSource, winRate: leadWin },
        followup: { status: q.status, sentDaysAgo: q.sentAt ? (nowMs() - Date.parse(q.sentAt)) / 86400000 : null }
      };

      const weights = await this._trackWeights();
      const result = this.deliberate(ctx, { weights: weights });

      const id = ids() ? ids().createId('cs') : 'cs_' + Date.now();
      const session = Object.assign({
        id: id, workspaceId: ws(), type: 'quote', quoteId: ctx.quoteId, jobId: ctx.jobId, customerName: ctx.customerName,
        status: 'pending_approval', approvedBy: null, approvedAt: null, ownerDecision: null, predictionId: null, createdAt: nowISO()
      }, result);

      // Prediction hook: log the council's decision so the ledger/supervisor score it.
      try {
        const predId = ids() ? ids().createId('dec') : 'dec_' + Date.now();
        const decision = { id: predId, agent: 'agent_council', kind: 'council_decision', sessionId: id, jobId: ctx.jobId, recommendation: result.decision, confidence: result.decisionConfidence, workspaceId: ws(), createdAt: nowISO() };
        await data().put('agent_decisions', predId, decision);
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('agent_decisions', predId, decision);
        session.predictionId = predId;
      } catch (_) {}

      await put(session);
      return { ok: true, session: session };
    },

    async list() { return (await data().list(SESSIONS)).filter(mine).sort(byNewest); },
    async get(id) { const r = await data().get(SESSIONS, id); return mine(r) ? r : null; },

    /** Owner acts on a council decision (accept or override) — gateway-audited. Advisory. */
    async act(sessionId, opts) {
      const o = opts || {};
      const s = await this.get(sessionId); if (!s) return { ok: false, error: 'NOT_FOUND' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const ownerDecision = ['approve', 'revise', 'reject'].indexOf(o.decision) !== -1 ? o.decision : s.decision;
      const res = await gw.run({
        action: 'REVIEW_COUNCIL', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'council_session', id: sessionId }, detail: { councilDecision: s.decision, ownerDecision: ownerDecision },
        mutate: async () => {
          const rec = Object.assign({}, s, { status: 'reviewed', ownerDecision: ownerDecision, overridden: ownerDecision !== s.decision, approvedBy: o.actor || null, approvedAt: nowISO() });
          await put(rec); return rec;
        }
      });
      if (!res.ok) return res;
      return { ok: true, session: res.result, auditId: res.auditId };
    },

    /** Leaderboard: each seat's track record (Supervisor) + council participation. */
    async leaderboard() {
      let per = {};
      try { if (supervisor() && supervisor().metrics) { const m = await supervisor().metrics(); per = (m && m.perAgent) || {}; } } catch (_) {}
      const sessions = await this.list();
      const votes = {}, conf = {};
      sessions.forEach((s) => (s.positions || []).forEach((p) => {
        if (p.stance === 'abstain') return;
        votes[p.id] = (votes[p.id] || 0) + 1;
        (conf[p.id] = conf[p.id] || []).push(num(p.confidence));
      }));
      return MEMBERS.map((m) => {
        const p = per[m.id] || {};
        const cs = conf[m.id] || [];
        return {
          agent: m.id, title: m.title,
          decisions: p.decisions || 0,
          accuracyPct: typeof p.avgScore === 'number' ? Math.round(p.avgScore * 100) : null,
          councilVotes: votes[m.id] || 0,
          avgCouncilConfidence: cs.length ? Math.round(cs.reduce((a, b) => a + b, 0) / cs.length) : null
        };
      }).sort((a, b) => (b.accuracyPct == null ? -1 : b.accuracyPct) - (a.accuracyPct == null ? -1 : a.accuracyPct) || b.councilVotes - a.councilVotes);
    },

    async _trackWeights() {
      const w = {};
      try { if (supervisor() && supervisor().metrics) { const m = await supervisor().metrics(); const per = (m && m.perAgent) || {}; Object.keys(per).forEach((k) => { if (typeof per[k].avgScore === 'number') w[k] = per[k].avgScore; }); } } catch (_) {}
      return w;
    }
  };

  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  async function put(rec) {
    await data().put(SESSIONS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(SESSIONS, rec.id, rec); } catch (_) {}
  }

  global.AAA_AGENT_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
