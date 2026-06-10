/*
 * AAA Copilot UI — mobile-first "Talk To My Business" interface.
 *
 * Five screens: Talk · Briefing · Simulate · Goals · Observatory. The screen
 * data is produced by renderModel() — a PURE read model (testable with no DOM).
 * mount(el) renders real DOM only when a document exists; otherwise it is a
 * no-op that still returns the model. Owner-facing, fast, Pixel-friendly.
 */
;(function (global) {
  'use strict';

  function copilot() { return global.AAA_EXECUTIVE_COPILOT; }
  function canvas() { return global.AAA_CHAT_CANVAS; }
  function cardRenderer() { return global.AAA_RICH_CARD_RENDERER; }
  function briefing() { return global.AAA_MORNING_BRIEFING_ENGINE; }
  function observatory() { return global.AAA_COPILOT_DASHBOARD; }
  function voice() { return global.AAA_VOICE_INPUT_ADAPTER; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }

  const SCREENS = ['talk', 'briefing', 'simulate', 'goals', 'observatory'];

  const UI = {
    SCREENS: SCREENS.slice(),

    /** Pure render model for all five screens (no DOM). */
    async renderModel(opts) {
      const o = opts || {};
      const model = {
        inputMode: voice() ? voice().mode() : 'text',
        voiceSupported: voice() ? voice().isSupported() : false,
        screens: {
          talk: { title: 'Talk To My Business', suggestedQuestions: copilot() ? copilot().SUGGESTED_QUESTIONS.slice() : [], placeholder: 'Ask anything about the business…' },
          simulate: { title: 'Simulate', quickPrompts: ['What if I raise prices 5%?', 'What if I add a crew?', 'What if fuel doubles?', 'What if a hurricane hits Houston?'] },
          goals: { title: 'Goals', quickGoals: ['Add $50k/month revenue', 'Increase close rate', 'Reduce callbacks'] }
        }
      };
      model.screens.briefing = { title: 'Executive Briefing', data: briefing() ? await briefing().briefing({ now: o.now }) : { status: 'unavailable' } };
      model.screens.observatory = { title: 'Observatory', data: observatory() ? await observatory().view({}) : { status: 'unavailable' } };
      return model;
    },

    /** Ask from the Talk screen (delegates to the Copilot). */
    async ask(text, opts) { return copilot() ? copilot().ask(text, opts) : { ok: false, error: 'COPILOT_UNAVAILABLE' }; },

    /** Render a single answer to a compact HTML card (string; safe to inject). */
    answerCard(answer) {
      const a = (answer && answer.answer) || {};
      const conf = answer && answer.confidence != null ? Math.round(answer.confidence * 100) + '%' : '—';
      const missing = (answer && answer.missingData && answer.missingData.length) ? '<div class="cp-missing">Missing: ' + esc(answer.missingData.join(', ')) + '</div>' : '';
      const gov = answer && answer.governanceRequired ? '<div class="cp-gov">⚖️ Needs your approval before acting</div>' : '';
      return '<div class="cp-card"><div class="cp-summary">' + esc(a.summary || '') + '</div>' +
        '<div class="cp-meta">confidence ' + conf + '</div>' + gov + missing + '</div>';
    },

    /** Chat Canvas render model: the thread + rendered card HTML per message. */
    async chatRenderModel(opts) {
      const o = opts || {};
      const thread = canvas() ? await canvas().thread(o.threadId) : [];
      return {
        title: 'Talk To My Business',
        suggestedPrompts: ['How are we doing today?', 'Run simulation: raise repair pricing 5%', 'Create goal: add $50k/month revenue', 'Build a review dashboard', 'What are my biggest risks?'],
        messages: thread.map(function (m) { return { role: m.role, text: m.text, cardHtml: (m.card && cardRenderer()) ? cardRenderer().html(m.card) : null, card: m.card || null, at: m.at }; })
      };
    },

    /** Send through the Chat Canvas (the primary chat path). */
    async chatSend(text, opts) { return canvas() ? canvas().send(text, opts) : { queued: false, error: 'CANVAS_UNAVAILABLE' }; },

    /** Mount the mobile Chat Canvas into a DOM element (DOM-guarded). */
    mountChat(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body; const self = this;
      const wrap = document.createElement('div'); wrap.className = 'cc-root';
      const thread = document.createElement('div'); thread.className = 'cc-thread';
      const bar = document.createElement('div'); bar.className = 'cc-bar';
      const input = document.createElement('input'); input.className = 'cc-input'; input.placeholder = 'Ask your business…';
      const send = document.createElement('button'); send.className = 'cc-send'; send.textContent = 'Send';
      send.onclick = async function () { const text = input.value; input.value = ''; const r = await self.chatSend(text, opts); const u = document.createElement('div'); u.className = 'cc-msg cc-user'; u.textContent = text; thread.appendChild(u); const a = document.createElement('div'); a.className = 'cc-msg cc-assistant'; a.innerHTML = (r.card && cardRenderer()) ? cardRenderer().html(r.card) : (r.queued ? 'Queued (offline) — will send when back online.' : ''); thread.appendChild(a); thread.scrollTop = thread.scrollHeight; };
      bar.appendChild(input); bar.appendChild(send); wrap.appendChild(thread); wrap.appendChild(bar); root.appendChild(wrap);
      return { mounted: true };
    },

    /** Mount the UI into a DOM element — only when a document exists. */
    mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const self = this;
      const wrap = document.createElement('div'); wrap.className = 'cp-root';
      const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Ask your business…'; input.className = 'cp-input';
      const out = document.createElement('div'); out.className = 'cp-out';
      const send = document.createElement('button'); send.textContent = 'Ask'; send.className = 'cp-send';
      send.onclick = async function () { const r = await self.ask(input.value, opts); out.innerHTML = self.answerCard(r); };
      if (voice() && voice().isSupported()) { const mic = document.createElement('button'); mic.textContent = '🎤'; mic.className = 'cp-mic'; mic.onclick = function () { voice().listen(function (t, m) { input.value = t; if (m.final) send.onclick(); }); }; wrap.appendChild(mic); }
      wrap.appendChild(input); wrap.appendChild(send); wrap.appendChild(out); root.appendChild(wrap);
      return { mounted: true };
    }
  };

  global.AAA_COPILOT_UI = UI;
})(typeof window !== 'undefined' ? window : this);
