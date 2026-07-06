/*
 * AAA Chat Canvas — the conversational brain of the mobile app.
 *
 * send(text) stores the user message, routes it through the existing Executive
 * Copilot (via the chat intent router), and produces an embedded RICH CARD from
 * real council/read-model output — executive briefing, simulation, goal,
 * software-factory, or governance-approval. Offline messages queue locally and
 * replay when online. No fake answers (insufficient_data shown honestly), no
 * production mutation (protected actions render an approval card, never act).
 */
;(function (global) {
  'use strict';

  function store() { return global.AAA_CHAT_MESSAGE_STORE; }
  function queue() { return global.AAA_OFFLINE_CHAT_QUEUE; }
  function router() { return global.AAA_CHAT_INTENT_ROUTER; }
  function copilot() { return global.AAA_EXECUTIVE_COPILOT; }
  function card(name) { return global['AAA_' + name]; }

  const OWNER_ACTIONS = [
    'Show what needs attention',
    'Build an estimate',
    'Who should I call today?',
    'Review open quotes',
    'Check today\'s jobs',
    'What are my biggest risks?'
  ];

  function friendlyHomeCard(kind) {
    const hello = kind === 'help'
      ? 'Here are the fastest things I can help with.'
      : 'Hey — I\'m here. Ask me anything about jobs, quotes, leads, money, scheduling, reviews, or estimates.';
    return {
      type: 'business_copilot_home',
      title: 'AAA Business Copilot',
      summary: hello,
      actions: OWNER_ACTIONS.slice(),
      confidence: 0.95,
      missingData: []
    };
  }

  function smarterFallbackCard(text, route) {
    const t = String(text == null ? '' : text).trim();
    return {
      type: 'business_copilot_home',
      title: 'AAA Business Copilot',
      summary: t
        ? 'I can help with that. Tell me whether this is about a job, estimate, customer, schedule, money, reviews, or leads — or tap one of these actions.'
        : 'Ask me about jobs, quotes, leads, scheduling, reviews, money, or what needs attention today.',
      actions: OWNER_ACTIONS.slice(),
      confidence: route && route.confidence != null ? route.confidence : 0.45,
      missingData: []
    };
  }

  async function buildCard(intent, cardType, text, answer, opts) {
    if (cardType === 'business_copilot_home') return friendlyHomeCard(intent);
    if (cardType === 'software_factory') return card('SOFTWARE_FACTORY_CARD') ? await card('SOFTWARE_FACTORY_CARD').build(text, opts) : { type: 'text', summary: 'Software factory unavailable.' };
    if (intent === 'governance_approval') return card('GOVERNANCE_APPROVAL_CARD') ? await card('GOVERNANCE_APPROVAL_CARD').build(null) : { type: 'text', summary: 'Nothing to approve.' };
    if (cardType === 'simulation') return card('SIMULATION_RESULT_CARD') ? card('SIMULATION_RESULT_CARD').build(answer) : { type: 'text', summary: (answer.answer && answer.answer.summary) || '' };
    if (cardType === 'goal') return card('GOAL_PROGRESS_CARD') ? card('GOAL_PROGRESS_CARD').build(answer) : { type: 'text', summary: (answer.answer && answer.answer.summary) || '' };
    if (cardType === 'governance_approval') return card('GOVERNANCE_APPROVAL_CARD') ? await card('GOVERNANCE_APPROVAL_CARD').build(answer && answer.approvalPackage) : { type: 'text', summary: 'Approval required.' };
    if (cardType === 'executive_briefing') return card('EXECUTIVE_BRIEFING_CARD') ? card('EXECUTIVE_BRIEFING_CARD').build(answer) : { type: 'text', summary: (answer.answer && answer.answer.summary) || '' };
    // text / unknown
    const a = (answer && answer.answer) || {};
    return { type: 'text', summary: a.summary || '', suggestions: a.suggestions || [], confidence: answer && answer.confidence, missingData: (answer && answer.missingData) || [] };
  }

  const Canvas = {
    /** Send a message → stored user msg + assistant msg with a rich card. */
    async send(text, opts) {
      const o = opts || {};
      const cleanText = String(text == null ? '' : text).trim();
      const online = queue() ? queue().isOnline() : true;
      const userMsg = store() ? await store().add({ role: 'user', text: cleanText, status: online ? 'sent' : 'queued', threadId: o.threadId }) : null;

      if (!online && !o._replay) {
        if (queue()) await queue().enqueue({ text: cleanText, opts: o });
        return { queued: true, userMessage: userMsg };
      }

      const route = router() ? router().classify(cleanText) : { intent: 'unknown', cardType: 'text', confidence: 0 };

      if (route.cardType === 'business_copilot_home') {
        const homeCard = await buildCard(route.intent, route.cardType, cleanText, {}, o);
        const homeMsg = store() ? await store().add({ role: 'assistant', text: homeCard.summary, card: homeCard, threadId: o.threadId, status: 'sent' }) : null;
        return { queued: false, intent: route.intent, cardType: route.cardType, confidence: route.confidence, userMessage: userMsg, assistantMessage: homeMsg, card: homeCard, answer: null };
      }

      // Company Brain — evidence-cited answers for business questions the
      // copilot router doesn't claim (win rates, profitability, revenue
      // trends, pipeline). Only fires on the unknown route, so every existing
      // intent keeps its rich card; the brain never fabricates (each finding
      // cites source, metric, value, and sample size).
      if (route.intent === 'unknown' && global.AAA_COMPANY_BRAIN && global.AAA_COMPANY_BRAIN.ask) {
        try {
          const brain = await global.AAA_COMPANY_BRAIN.ask(cleanText);
          // Only pre-empt the copilot when the brain actually brings evidence —
          // a recognized intent with zero findings means it couldn't answer
          // from data, so let the copilot path handle it.
          if (brain && brain.ok && brain.intent !== 'unknown' && brain.answer && Array.isArray(brain.answer.findings) && brain.answer.findings.length) {
            const lines = (brain.answer.findings || []).map(function (f) {
              return '• ' + f.claim + (f.evidence ? ' (' + f.evidence.source + ' · n=' + f.evidence.sample + ')' : '');
            });
            if (brain.answer.caveat) lines.push('⚠ ' + brain.answer.caveat);
            const brainCard = { type: 'text', summary: [brain.answer.headline].concat(lines).join('\n'), suggestions: [], confidence: brain.confidence, missingData: [] };
            const brainMsg = store() ? await store().add({ role: 'assistant', text: brain.answer.headline, card: brainCard, threadId: o.threadId, status: 'sent' }) : null;
            return { queued: false, intent: 'company_brain.' + brain.intent, cardType: 'text', confidence: brain.confidence, userMessage: userMsg, assistantMessage: brainMsg, card: brainCard, answer: brain };
          }
        } catch (_) { /* fall through to the copilot path */ }
      }

      let answer = null;
      const needsCopilot = route.intent !== 'software_factory' && route.intent !== 'governance_approval';
      if (needsCopilot && copilot()) answer = await copilot().ask(cleanText, o);

      let cardModel = await buildCard(route.intent, route.cardType, cleanText, answer || {}, o);
      const weakUnknown = route.intent === 'unknown' && (!cardModel || !String(cardModel.summary || '').trim());
      if (weakUnknown) cardModel = smarterFallbackCard(cleanText, route);

      const summary = (answer && answer.answer && answer.answer.summary) || cardModel.summary || cardModel.title || 'Done.';
      const assistantMsg = store() ? await store().add({ role: 'assistant', text: summary, card: cardModel, threadId: o.threadId, status: 'sent' }) : null;

      return { queued: false, intent: route.intent, cardType: route.cardType, confidence: route.confidence, userMessage: userMsg, assistantMessage: assistantMsg, card: cardModel, answer: answer };
    },

    /** The full thread (oldest first). */
    async thread(threadId) { return store() ? store().thread(threadId) : []; },

    /** Replay any queued messages now that we're online. */
    async replayQueue(opts) {
      const o = opts || {};
      const self = this;
      if (!queue()) return { replayed: 0 };
      return queue().replay(function (text) { return self.send(text, Object.assign({}, o, { _replay: true })); });
    }
  };

  global.AAA_CHAT_CANVAS = Canvas;
})(typeof window !== 'undefined' ? window : this);
