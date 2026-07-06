/*
 * AAA Chat Intent Router — maps a chat message to an intent AND the rich card
 * that should render the answer.
 *
 * Delegates to the existing Executive Copilot intent router (requirement: chat
 * uses the same router), and adds chat-native intents the canvas needs:
 * `greeting` ("hi"), `help` ("what can you do?"), `software_factory`
 * ("build a review dashboard"), and `governance_approval` ("approve this change").
 * Pure; deterministic.
 */
;(function (global) {
  'use strict';

  function base() { return global.AAA_COPILOT_INTENT_ROUTER; }

  // copilot intent → chat card type
  const CARD_FOR = {
    greeting: 'business_copilot_home',
    help: 'business_copilot_home',
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

  function normalized(text) { return String(text == null ? '' : text).trim().toLowerCase(); }

  const Router = {
    classify(text) {
      const t = normalized(text);
      // Friendly chat-native intents first. A business copilot should not treat
      // "hi" as confusion — it should open the owner command surface.
      if (/^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|gm|👋)[!.\s]*$/.test(t)) {
        return { intent: 'greeting', cardType: 'business_copilot_home', confidence: 0.95, base: null };
      }
      if (/^(help|what can you do|what can you help with|show commands|commands|suggestions|menu)[?!.\s]*$/.test(t)) {
        return { intent: 'help', cardType: 'business_copilot_home', confidence: 0.9, base: null };
      }
      // Common owner shorthand should route to a useful business status answer.
      if (/^(what's going on|whats going on|anything important|what needs attention|what should i do|what now|status|update)[?!.\s]*$/.test(t)) {
        return { intent: 'business_status', cardType: 'executive_briefing', confidence: 0.85, base: null };
      }
      // Chat-native build / approval intents.
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
