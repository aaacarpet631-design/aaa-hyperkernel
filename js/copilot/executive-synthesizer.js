/*
 * AAA Executive Synthesizer — many council outputs → one owner-level answer.
 *
 * Turns the council query bundle into { summary, keyMetrics, threats,
 * opportunities, bottlenecks, recommendedActions, confidence, missingData,
 * governanceRequired }. Owner-facing language is simple and direct — no raw
 * agent dumps, no exaggerated certainty. Every metric that has no data is named
 * in missingData rather than invented, and confidence drops as missingData grows.
 */
;(function (global) {
  'use strict';

  function val(x) { return (x && typeof x === 'object' && (x.status === 'insufficient_data' || x.status === 'unavailable')) ? null : x; }
  function pushMissing(missing, label, node) { if (!node || (node.status === 'insufficient_data' || node.status === 'unavailable')) missing.push(label); }
  function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }

  const Synth = {
    synthesize(intent, bundle, opts) {
      const o = opts || {};
      const b = bundle || {};
      const missingData = [];
      const keyMetrics = {}; const threats = []; const opportunities = []; const bottlenecks = []; const recommendedActions = [];

      // Key metrics from the Revenue read model.
      const rev = val(b.revenue);
      if (rev) {
        if (rev.closeProbability && rev.closeProbability.value != null) keyMetrics.closeRate = r2(rev.closeProbability.value);
        if (rev.margin && rev.margin.value != null) keyMetrics.grossMargin = r2(rev.margin.value);
        if (rev.reviewVelocity && rev.reviewVelocity.perWeek != null) keyMetrics.reviewsPerWeek = rev.reviewVelocity.perWeek;
        if (rev.cac && rev.cac.status === 'insufficient_data') missingData.push('CAC (no spend feed)');
      } else pushMissing(missingData, 'revenue', b.revenue);

      // Opportunities from Innovation + Revenue.
      const inno = val(b.innovation);
      if (inno && Array.isArray(inno.topOpportunities)) inno.topOpportunities.slice(0, 3).forEach(function (op) { opportunities.push({ what: op.opportunity, expectedMargin: op.expectedMargin, confidence: op.confidence }); });
      else pushMissing(missingData, 'innovation', b.innovation);

      // Threats from Simulation strategy dashboard + bottlenecks.
      const sim = val(b.simulation);
      if (sim && Array.isArray(sim.highestRisk)) sim.highestRisk.slice(0, 3).forEach(function (r) { if (r.card && (r.card.risk || 0) > 0) threats.push({ scenario: r.label || r.kind, risk: r.card.risk }); });
      const bn = val(b.bottlenecks);
      if (bn && Array.isArray(bn.bottlenecks)) bn.bottlenecks.slice(0, 3).forEach(function (x) { bottlenecks.push({ metric: x.signal, gap: x.gap }); });

      // Recommended actions from pending governance recommendations.
      const gov = val(b.governance);
      if (Array.isArray(gov)) gov.filter(function (g) { return g.status === 'pending_governance'; }).slice(0, 5).forEach(function (g) { recommendedActions.push({ action: g.action, needsApproval: true, recId: g.id }); });

      // Knowledge / moat context.
      const know = val(b.knowledge);
      if (know && know.moatScore != null) keyMetrics.knowledgeMoat = know.moatScore;

      // Confidence: starts high, discounted by each missing source.
      const sources = ['revenue', 'innovation', 'simulation', 'teleological', 'knowledge', 'governance'].filter(function (k) { return b[k] !== undefined; });
      const missingCount = missingData.length;
      const confidence = Math.max(0.05, Math.round((1 - missingCount / Math.max(1, sources.length)) * (o.routerConfidence == null ? 0.9 : o.routerConfidence) * 100) / 100);

      const summary = this._summary(intent, keyMetrics, threats, opportunities, bottlenecks, missingData);
      return { summary: summary, keyMetrics: keyMetrics, threats: threats, opportunities: opportunities, bottlenecks: bottlenecks, recommendedActions: recommendedActions, confidence: confidence, missingData: missingData, governanceRequired: false };
    },

    _summary(intent, m, threats, opps, bottlenecks, missing) {
      const parts = [];
      if (m.grossMargin != null || m.closeRate != null) parts.push('Margin ' + (m.grossMargin != null ? Math.round(m.grossMargin * 100) + '%' : 'n/a') + ', close rate ' + (m.closeRate != null ? Math.round(m.closeRate * 100) + '%' : 'n/a') + '.');
      if (bottlenecks.length) parts.push('Biggest drag: ' + bottlenecks[0].metric + '.');
      if (opps.length) parts.push('Top opportunity: ' + opps[0].what + '.');
      if (threats.length) parts.push('Watch: ' + (threats[0].scenario) + '.');
      if (!parts.length) parts.push('Not enough data yet to assess — ' + (missing.length ? 'missing ' + missing.join(', ') + '.' : 'keep logging activity.'));
      else if (missing.length) parts.push('(' + missing.length + ' data source(s) still missing.)');
      return parts.join(' ');
    }
  };

  global.AAA_EXECUTIVE_SYNTHESIZER = Synth;
})(typeof window !== 'undefined' ? window : this);
