/*
 * AAA Executive Briefing Card — the "how are we doing" answer as a rich card.
 *
 * Builds a pure card model from a Copilot answer (synthesis OR a morning
 * briefing) — summary, key metrics, threats, opportunities, bottlenecks,
 * recommended actions, confidence, and honest missingData. No fabrication: a
 * field with no data simply isn't shown, and missingData is surfaced.
 */
;(function (global) {
  'use strict';

  const Card = {
    build(answer) {
      const a = (answer && answer.answer) || {};
      const brief = a.briefing || null;
      if (brief) {
        return {
          type: 'executive_briefing', title: 'Executive Briefing',
          summary: a.summary || brief.recommendedFocus || '',
          keyMetrics: { revenue: brief.revenueSnapshot, leads: brief.leadSnapshot },
          threats: brief.risks || [], opportunities: brief.opportunities || [], bottlenecks: brief.bottlenecks || [],
          recommendedActions: brief.recommendedFocus ? [{ action: brief.recommendedFocus }] : [],
          experiments: brief.experiments || [],
          confidence: answer.confidence == null ? null : answer.confidence,
          missingData: brief.missingData || []
        };
      }
      return {
        type: 'executive_briefing', title: 'Business Status',
        summary: a.summary || '',
        keyMetrics: a.keyMetrics || {},
        threats: a.threats || [], opportunities: a.opportunities || [], bottlenecks: a.bottlenecks || [],
        recommendedActions: a.recommendedActions || [],
        confidence: (a.confidence != null ? a.confidence : answer && answer.confidence) || null,
        missingData: a.missingData || (answer && answer.missingData) || []
      };
    }
  };

  global.AAA_EXECUTIVE_BRIEFING_CARD = Card;
})(typeof window !== 'undefined' ? window : this);
