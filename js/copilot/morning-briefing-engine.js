/*
 * AAA Morning Briefing Engine — the owner's daily one-screen brief.
 *
 * Composes the council read models into { date, revenueSnapshot, leadSnapshot,
 * operationsSnapshot, risks, opportunities, bottlenecks, experiments,
 * recommendedFocus, missingData }. Every field is real or honestly
 * insufficient_data — no fabricated numbers. Read-only.
 */
;(function (global) {
  'use strict';

  function query() { return global.AAA_COPILOT_COUNCIL_QUERY; }
  function discovery() { return global.AAA_SCIENTIFIC_DISCOVERY_COUNCIL; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function ok(x) { return x && !(x.status === 'insufficient_data' || x.status === 'unavailable'); }

  const Engine = {
    async briefing(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const missingData = [];
      const b = query() ? await query().query({ now: now, councils: ['revenue', 'innovation', 'simulation', 'teleological', 'governance', 'bottlenecks'] }) : {};

      const rev = ok(b.revenue) ? b.revenue : null; if (!rev) missingData.push('revenue');
      const inno = ok(b.innovation) ? b.innovation : null; if (!inno) missingData.push('innovation');
      const sim = ok(b.simulation) ? b.simulation : null;
      const bn = ok(b.bottlenecks) ? b.bottlenecks : null; if (!bn) missingData.push('bottlenecks');
      const gov = Array.isArray(b.governance) ? b.governance : [];

      const revenueSnapshot = rev ? { closeProbability: rev.closeProbability, margin: rev.margin, reviewVelocity: rev.reviewVelocity } : { status: 'insufficient_data' };
      const leadSnapshot = rev ? { leadQuality: rev.leadQuality } : { status: 'insufficient_data' };
      const operationsSnapshot = { status: 'insufficient_data', note: 'live crew/schedule telemetry not yet wired' };
      const risks = sim && Array.isArray(sim.highestRisk) ? sim.highestRisk.slice(0, 3).map(function (r) { return { scenario: r.label || r.kind, risk: r.card && r.card.risk }; }) : [];
      const opportunities = inno && Array.isArray(inno.topOpportunities) ? inno.topOpportunities.slice(0, 3) : [];
      const bottlenecks = bn && Array.isArray(bn.bottlenecks) ? bn.bottlenecks.slice(0, 3) : [];
      let experiments = [];
      if (discovery()) { const a = await discovery().researchAgenda(now); experiments = (a.questions || []).slice(0, 3).map(function (q) { return q.question; }); }

      const pending = gov.filter(function (g) { return g.status === 'pending_governance'; });
      let recommendedFocus;
      if (bottlenecks.length) recommendedFocus = 'Attack the biggest drag: ' + bottlenecks[0].signal + '.';
      else if (pending.length) recommendedFocus = 'Decide on ' + pending.length + ' pending recommendation(s) awaiting your approval.';
      else if (opportunities.length) recommendedFocus = 'Advance the top opportunity: ' + opportunities[0].opportunity + '.';
      else recommendedFocus = 'No urgent signal — keep logging activity so the brief sharpens.';

      return { date: nowISO(), revenueSnapshot: revenueSnapshot, leadSnapshot: leadSnapshot, operationsSnapshot: operationsSnapshot, risks: risks, opportunities: opportunities, bottlenecks: bottlenecks, experiments: experiments, recommendedFocus: recommendedFocus, pendingApprovals: pending.length, missingData: missingData };
    }
  };

  global.AAA_MORNING_BRIEFING_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
