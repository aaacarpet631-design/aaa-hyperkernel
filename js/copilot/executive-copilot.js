/*
 * AAA Executive Copilot — the bridge between HyperKernel's brain and the
 * owner's voice.
 *
 * ask(text) routes a plain-English business question to the right system and
 * returns one clear, owner-level answer:
 *   1. classify intent (router)
 *   2. governance gate — a protected action is never performed, only proposed
 *      (HUMAN_APPROVAL_REQUIRED + approval package)
 *   3. low confidence on a protected/unknown ask → clarify, do not execute
 *   4. route: simulation → Simulation Council; goal → Teleological Engine;
 *      briefing → Briefing engine; analysis → council query + synthesis
 *   5. enrich with retrieved knowledge (theories/beliefs)
 *
 * Read-only everywhere except governance proposals. No fabricated answers — it
 * surfaces insufficient_data honestly. No raw agent dumps.
 */
;(function (global) {
  'use strict';

  function router() { return global.AAA_COPILOT_INTENT_ROUTER; }
  function gate() { return global.AAA_COPILOT_GOVERNANCE_GATE; }
  function query() { return global.AAA_COPILOT_COUNCIL_QUERY; }
  function synth() { return global.AAA_EXECUTIVE_SYNTHESIZER; }
  function sim() { return global.AAA_COPILOT_SIMULATION_INTERFACE; }
  function goal() { return global.AAA_COPILOT_GOAL_INTERFACE; }
  function briefing() { return global.AAA_MORNING_BRIEFING_ENGINE; }
  function memory() { return global.AAA_COPILOT_MEMORY; }

  const MIN_CONFIDENCE = 0.3;

  const Copilot = {
    SUGGESTED_QUESTIONS: [
      'How are we doing this week?', 'Why are leads down?', 'What should I do today?',
      'How much money did we make?', 'What happens if I raise prices 5%?', 'What happens if I hire another crew?',
      'How do I add $50k per month?', 'What are my biggest risks?', 'What are my best opportunities?'
    ],

    /** Answer a business question. → unified owner-level answer. */
    async ask(text, opts) {
      const o = opts || {};
      const route = router() ? router().classify(text) : { intent: 'unknown', confidence: 0, requiredCouncils: [], governanceRequired: false };

      // 2. Governance gate — only an imperative (governance_action intent) can
      //    be a protected ACTION. Analysis/simulation/goal intents are read-only
      //    or proposal-only and never perform anything, so a word like "price"
      //    in "what if I raise prices?" is a question, not an action.
      if (route.intent === 'governance_action') {
        const g = gate() ? await gate().gate(text, { confidence: route.confidence }) : { allowed: false, interruptSignal: 'HUMAN_APPROVAL_REQUIRED' };
        return { ok: true, intent: route.intent, confidence: route.confidence, governanceRequired: true, interruptSignal: g.interruptSignal || 'HUMAN_APPROVAL_REQUIRED', approvalPackage: g.approvalPackage || null, answer: { summary: 'That\'s a protected action — I\'ve prepared it for your approval rather than doing it myself.', category: g.category } };
      }

      // 3. Low confidence / unknown → clarify, never guess a protected path.
      if (route.intent === 'unknown' || route.confidence < MIN_CONFIDENCE) {
        return { ok: true, intent: 'unknown', confidence: route.confidence, governanceRequired: false, answer: { summary: 'I\'m not sure which part of the business you mean. Try one of the suggested questions.', suggestions: this.SUGGESTED_QUESTIONS.slice(0, 5) }, missingData: [] };
      }

      // 4. Route to the right system.
      let answer, governanceRequired = false, missingData = [];
      if (route.intent === 'simulation_request') {
        const r = sim() ? await sim().run(text, o) : { status: 'unavailable' };
        answer = { summary: r.status === 'simulated' ? ('Simulated: ' + r.recommendation) : 'I couldn\'t run that scenario.', simulation: r };
        if (r.status === 'simulated') governanceRequired = !!r.approvalRequired;
        if (r.status !== 'simulated') missingData.push('simulation');
      } else if (route.intent === 'goal_request') {
        const r = goal() ? await goal().createGoal(text, o) : { status: 'unavailable' };
        answer = { summary: r.status === 'planned' ? ('Goal set: ' + (r.target && r.target.label) + '. I mapped the delta, gaps, and experiments — nothing runs without your approval.') : 'I couldn\'t turn that into a goal.', goal: r };
        governanceRequired = true; // acting on a goal always needs approval
      } else if (route.intent === 'morning_briefing') {
        const r = briefing() ? await briefing().briefing(o) : { status: 'unavailable' };
        answer = { summary: r.recommendedFocus || 'Briefing unavailable.', briefing: r };
        missingData = r.missingData || [];
      } else {
        const bundle = query() ? await query().query({ now: o.now, councils: (route.requiredCouncils && route.requiredCouncils.length ? route.requiredCouncils.concat(['bottlenecks']) : undefined) }) : {};
        const s = synth() ? synth().synthesize(route.intent, bundle, { routerConfidence: route.confidence }) : { summary: 'No synthesizer.', missingData: [] };
        answer = s; missingData = s.missingData || [];
      }

      // 5. Enrich with what the company already knows.
      if (memory()) { try { answer.knowledge = await memory().retrieve(text, {}); } catch (_) {} }

      return { ok: true, intent: route.intent, confidence: route.confidence, governanceRequired: governanceRequired, answer: answer, missingData: missingData };
    }
  };

  global.AAA_EXECUTIVE_COPILOT = Copilot;
})(typeof window !== 'undefined' ? window : this);
