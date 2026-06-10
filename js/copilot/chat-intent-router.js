/*
 * AAA Chat Intent Router — maps a chat message to an intent AND the rich card
 * that should render the answer.
 *
 * Delegates to the existing Executive Copilot intent router (requirement: chat
 * uses the same router), and adds two chat-native intents the canvas needs:
 * `software_factory` ("build a review dashboard") and `governance_approval`
 * ("approve this change"). Pure; deterministic.
 */
;(function (global) {
  'use strict';

  function base() { return global.AAA_COPILOT_INTENT_ROUTER; }

  // copilot intent → chat card type
  const CARD_FOR = {
    business_status: 'executive_briefing',
    morning_briefing: 'executive_briefing',
    revenue_analysis: 'executive_briefing',
    operations_analysis: 'executive_briefing',
    customer_analysis: 'executive_briefing',
    estimate_analysis: 'executive_briefing',
    risk_report: 'executive_briefing',
    opportunity_report: 'executive_briefing',
    simulation_request: 'simulation',
    goal_request: 'goal',
    governance_action: 'governance_approval',
    unknown: 'text'
  };

  const Router = {
    classify(text) {
      const t = String(text == null ? '' : text).toLowerCase();
      // Chat-native intents first.
      if (/\b(build|create|make|ship)\b/.test(t) && /\b(dashboard|report|tool|feature|page|view|agent|widget|screen)\b/.test(t)) {
        return { intent: 'software_factory', cardType: 'software_factory', confidence: 0.8, base: null };
      }
      if (/\bapprove\b/.test(t)) {
        return { intent: 'governance_approval', cardType: 'governance_approval', confidence: 0.8, base: null };
      }
      const r = base() ? base().classify(text) : { intent: 'unknown', confidence: 0 };
      return { intent: r.intent, cardType: CARD_FOR[r.intent] || 'text', confidence: r.confidence, base: r };
    }
  };

  global.AAA_CHAT_INTENT_ROUTER = Router;
})(typeof window !== 'undefined' ? window : this);
