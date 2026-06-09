/*
 * AAA Hermes Gateway — the middleman between the app and the AI team.
 *
 * Modeled on the Hermes Agent gateway pattern: one chokepoint that receives a
 * message from any surface of the app (UI console, voice, automation, future
 * webhooks), decides which agent should handle it, runs that agent through the
 * existing orchestrator (AAA_AGENT_OS), keeps a per-channel session transcript,
 * and delivers the reply back to the channel that asked.
 *
 * Strictly a router/relay — it never mutates business data itself. All model
 * calls go through AAA_AGENT_OS (which logs decisions and gates next_actions),
 * and anything destructive still requires the human-only runtime gateway.
 * Honest by construction: with no proxy configured, sends return
 * { ok:false, error:'AI_NOT_CONFIGURED' } — never fabricated replies.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function registry() { return global.AAA_AGENTS; }
  function os() { return global.AAA_AGENT_OS; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(prefix) {
    const f = ids();
    if (f && f.createId) return f.createId(prefix);
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
  }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const COLLECTION = 'hermes_sessions';
  const MAX_HISTORY = 40; // per-channel transcript bound (most recent kept)

  // ---- routing table ---------------------------------------------------------
  // Deterministic keyword → agent routing (cheap, offline, testable). An
  // explicit "@agent" mention always wins; "@team" forces a full meeting.
  // Anything unmatched goes to the CEO, who owns the final call anyway.
  const ROUTES = [
    { agent: 'sales', keywords: ['lead', 'deal', 'close rate', 'win', 'prospect', 'pricing', 'discount', 'bid'] },
    { agent: 'operations', keywords: ['schedule', 'crew', 'capacity', 'route', 'dispatch', 'equipment', 'job site', 'reschedule'] },
    { agent: 'marketing', keywords: ['ads', 'campaign', 'referral', 'review', 'channel', 'seo', 'website', 'promotion'] },
    { agent: 'accounting', keywords: ['invoice', 'margin', 'cash', 'cost', 'profit', 'expense', 'payment', 'receivable'] },
    { agent: 'customer_success', keywords: ['retention', 'follow-up', 'follow up', 'complaint', 'satisfaction', 'repeat', 'churn', 'unhappy'] },
    { agent: 'kpi', keywords: ['kpi', 'metric', 'trend', 'target', 'dashboard', 'numbers'] },
    { agent: 'data_scientist', keywords: ['pattern', 'predict', 'forecast', 'analyze', 'correlation', 'model', 'data'] },
    { agent: 'compliance', keywords: ['legal', 'license', 'licensing', 'safety', 'contract', 'privacy', 'regulation', 'insurance'] }
  ];

  /**
   * Decide which agent should handle a message. Pure and synchronous.
   * @returns {{agent:string, reason:string, meeting?:boolean}}
   */
  function route(text) {
    const s = String(text || '').trim();
    const lower = s.toLowerCase();

    // "@team" / "@everyone" → full meeting (CEO synthesizes).
    if (/(^|\s)@(team|everyone|all)\b/.test(lower)) {
      return { agent: 'ceo', meeting: true, reason: 'explicit team mention' };
    }
    // "@agent" mention wins when the registry knows the id.
    const m = lower.match(/(^|\s)@([a-z_]+)\b/);
    if (m && registry() && registry().get(m[2])) {
      return { agent: m[2], reason: 'explicit @mention' };
    }
    // Keyword routing: best match by number of keyword hits.
    let best = null, bestHits = 0;
    for (let i = 0; i < ROUTES.length; i++) {
      let hits = 0;
      for (let k = 0; k < ROUTES[i].keywords.length; k++) {
        if (lower.indexOf(ROUTES[i].keywords[k]) !== -1) hits++;
      }
      if (hits > bestHits) { best = ROUTES[i].agent; bestHits = hits; }
    }
    if (best) return { agent: best, reason: 'keyword match (' + bestHits + ')' };
    return { agent: 'ceo', reason: 'default — CEO owns the final call' };
  }

  // ---- channels ---------------------------------------------------------------
  // A channel is any surface that wants replies delivered back to it (like the
  // Hermes gateway's platform adapters). { deliver(message) } is the contract.
  const CHANNELS = {}; // name -> { deliver }

  function registerChannel(name, handler) {
    if (!name || !handler || typeof handler.deliver !== 'function') {
      return { ok: false, error: 'BAD_CHANNEL' };
    }
    CHANNELS[String(name)] = { deliver: handler.deliver };
    return { ok: true, channel: String(name) };
  }

  async function deliver(channel, message) {
    const ch = CHANNELS[channel];
    if (!ch) return;
    try { const r = ch.deliver(message); if (r && typeof r.then === 'function') await r.catch(function () {}); } catch (_) {}
  }

  // ---- sessions ----------------------------------------------------------------
  function sessionId(channel) { return 'hermes_' + String(channel || 'app'); }

  async function getSession(channel) {
    const d = data();
    if (!d) return { id: sessionId(channel), channel: channel, messages: [] };
    const rec = await d.get(COLLECTION, sessionId(channel));
    return rec || { id: sessionId(channel), channel: channel, messages: [] };
  }

  async function appendToSession(channel, entries) {
    const d = data();
    if (!d) return null;
    const s = await getSession(channel);
    s.messages = (s.messages || []).concat(entries).slice(-MAX_HISTORY);
    s.updatedAt = nowISO();
    try { await d.put(COLLECTION, s.id, s); } catch (_) {}
    return s;
  }

  // ---- typed event (best-effort observability) ----------------------------------
  let contractDefined = false;
  function ensureContract() {
    const b = bus();
    if (!b || contractDefined) return;
    try {
      b.define('hermes.routed', {
        version: 1,
        description: 'Hermes gateway relayed a message to an agent.',
        schema: {
          type: 'object', required: ['id'],
          properties: { id: { type: 'string' }, channel: { type: 'string' }, agent: { type: 'string' } }
        }
      });
      contractDefined = true;
    } catch (_) {}
  }
  function publishRouted(channel, agent) {
    const b = bus();
    if (!b) return;
    ensureContract();
    try {
      const r = b.publish('hermes.routed', { id: newId('hroute'), channel: String(channel), agent: String(agent) }, { source: 'hermes' });
      if (r && typeof r.then === 'function') r.catch(function () {});
    } catch (_) {}
  }

  // ---- gateway commands (handled here, no model call) ----------------------------
  async function command(channel, cmd) {
    const reg = registry();
    if (cmd === '/help') {
      return { ok: true, command: cmd, reply:
        'Hermes gateway — talk to your AI team.\n' +
        '/agents — list agents · /status — gateway status · /reset — clear this channel\'s history\n' +
        'Mention @agent (e.g. @sales) to pick an agent, @team for a full meeting; otherwise I route by topic.' };
    }
    if (cmd === '/agents') {
      const idsList = reg && reg.ids ? reg.ids() : (reg && reg.all ? Object.keys(reg.all) : []);
      const lines = idsList.map(function (id) { const a = reg.get(id); return '@' + id + ' — ' + (a ? a.title : id); });
      return { ok: true, command: cmd, reply: lines.length ? lines.join('\n') : 'No agents registered.' };
    }
    if (cmd === '/status') {
      const st = Hermes.status();
      return { ok: true, command: cmd, reply:
        'AI: ' + (st.ready ? 'online' : 'not configured') +
        ' · agents: ' + st.agents +
        ' · channels: ' + st.channels.join(', ') };
    }
    if (cmd === '/reset') {
      await Hermes.reset(channel);
      return { ok: true, command: cmd, reply: 'Session cleared for channel "' + channel + '".' };
    }
    return { ok: false, error: 'UNKNOWN_COMMAND', reply: 'Unknown command ' + cmd + ' — try /help.' };
  }

  // ---- public API -----------------------------------------------------------------
  const Hermes = {
    /** True when the orchestrator can reach the model proxy. */
    isReady() { return !!(os() && os().isReady && os().isReady()); },

    /** Register a reply surface: { deliver(message) }. */
    registerChannel: registerChannel,
    channels() { return Object.keys(CHANNELS); },

    /** Pure routing decision for a message (exposed for tests/UI). */
    route: route,

    /**
     * The middleman entry point. Routes the message, runs the chosen agent via
     * AAA_AGENT_OS, records the exchange in the channel session, delivers the
     * reply to the channel, and returns the full result to the caller.
     * @param {{channel?:string, text:string, context?:object}} msg
     */
    async send(msg) {
      const m = msg || {};
      const channel = String(m.channel || 'app');
      const text = String(m.text || '').trim();
      if (!text) return { ok: false, error: 'EMPTY_MESSAGE' };

      // Gateway slash commands answer locally — no model, works offline.
      if (text.charAt(0) === '/') {
        const res = await command(channel, text.split(/\s/)[0]);
        await appendToSession(channel, [
          { role: 'user', text: text, at: nowISO() },
          { role: 'hermes', agent: 'hermes', text: res.reply, at: nowISO() }
        ]);
        await deliver(channel, { channel: channel, agent: 'hermes', text: res.reply });
        return res;
      }

      const r = route(text);
      if (!this.isReady()) {
        return { ok: false, error: 'AI_NOT_CONFIGURED', routed: r };
      }

      let result;
      if (r.meeting) {
        result = await os().runMeeting(text, m.context || {}, null);
        if (result && result.ok) {
          result = Object.assign({ agent: 'ceo' }, result.decision, { ok: true, opinions: result.opinions, decisionId: result.decisionId });
        }
      } else {
        result = await os().runAgent(r.agent, text, m.context || {});
      }
      if (!result || result.ok === false) {
        return { ok: false, error: (result && result.error) || 'CALL_FAILED', routed: r };
      }

      const reply = result.recommendation || '(no recommendation)';
      await appendToSession(channel, [
        { role: 'user', text: text, at: nowISO() },
        { role: 'hermes', agent: r.agent, text: reply, confidence: result.confidence, at: nowISO() }
      ]);

      // Best-effort observability — never blocks or fails the send.
      try { if (data() && data().logAgent) await data().logAgent('hermes', 'routed → ' + r.agent, { channel: channel, reason: r.reason, text: text.slice(0, 200) }); } catch (_) {}
      publishRouted(channel, r.agent);
      await deliver(channel, { channel: channel, agent: r.agent, text: reply, decision: result });

      return Object.assign({ ok: true, routed: r, reply: reply }, { decision: result });
    },

    /** Fan a topic out to multiple agents and let the CEO synthesize. */
    async broadcast(topic, context, participantIds) {
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      return os().runMeeting(topic, context || {}, participantIds || null);
    },

    /** The channel's transcript, oldest → newest (bounded). */
    async history(channel, limit) {
      const s = await getSession(String(channel || 'app'));
      const msgs = s.messages || [];
      return limit ? msgs.slice(-limit) : msgs;
    },

    /** Clear a channel's transcript. */
    async reset(channel) {
      const ch = String(channel || 'app');
      const d = data();
      if (d) { try { await d.put(COLLECTION, sessionId(ch), { id: sessionId(ch), channel: ch, messages: [], updatedAt: nowISO() }); } catch (_) {} }
      return { ok: true, channel: ch };
    },

    /** Gateway health at a glance. */
    status() {
      const reg = registry();
      return {
        ready: this.isReady(),
        agents: reg && reg.ids ? reg.ids().length : 0,
        channels: Object.keys(CHANNELS),
        routes: ROUTES.map(function (r) { return r.agent; })
      };
    }
  };

  global.AAA_HERMES = Hermes;
})(typeof window !== 'undefined' ? window : this);
