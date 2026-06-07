/*
 * AAA Transport Adapters — provider-NEUTRAL delivery pipes.
 *
 * AAA HyperKernel owns the communication brain (lifecycle, threads, inbox,
 * automation, AI, audit, analytics). An adapter is a DUMB PIPE that only knows
 * how to push bytes onto a network for one or more channels — and, optionally,
 * how to parse an inbound payload and a delivery-status callback from that same
 * network. Twilio is NOT the center of anything: it would be one adapter among
 * many, registered like any other.
 *
 * Adapter interface (duck-typed; only name/channels/send are required):
 *   {
 *     name: string,
 *     channels: ['sms'|'email'|'push'|'voice', ...],
 *     async send({channel, to, subject, body}) -> { ok:true, providerId } | throws,
 *     parseInbound(raw)     -> { channel, from, body, providerId } | null,   // optional
 *     normalizeStatus(raw)  -> { providerId, status, reason } | null,        // optional
 *     capabilities: { send, inbound, status }
 *   }
 *
 * Ships with a LOCAL loopback adapter (dev/test) that is honest: it reports the
 * message left through the local pipe — it never fakes a carrier "delivered".
 * Future adapters (direct carrier, SMTP, SendGrid, Gmail, WhatsApp, a Google-
 * Voice-style relay, in-app push) register the same way; none is hard-coded.
 */
;(function (global) {
  'use strict';

  const CHANNELS = ['sms', 'email', 'push', 'voice'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  // ---- the built-in LOCAL loopback adapter (dev/test; never fakes delivery) --
  function localAdapter() {
    return {
      name: 'local', channels: CHANNELS.slice(), local: true,
      capabilities: { send: true, inbound: true, status: true },
      async send(message) {
        // Loopback: the message genuinely left through the local pipe. We do NOT
        // claim the carrier delivered it — only that it was handed off locally.
        if (!message || !message.to) { const e = new Error('NO_RECIPIENT'); throw e; }
        return { ok: true, providerId: newId('local'), via: 'local' };
      },
      // Pass-through inbound for dev/test simulation: accepts an already-shaped
      // payload and returns it normalized. Real adapters parse their own format.
      parseInbound(raw) {
        const r = raw || {};
        const from = r.from || r.From || r.sender || null;
        const body = r.body || r.Body || r.text || '';
        if (!from) return null;
        return { channel: r.channel || 'sms', from: String(from), body: String(body), providerId: r.providerId || r.MessageSid || null };
      },
      // Pass-through status for dev/test. Real adapters map their own webhooks.
      normalizeStatus(raw) {
        const r = raw || {};
        const status = ['delivered', 'bounced', 'failed'].indexOf(r.status) !== -1 ? r.status : 'ignored';
        return { providerId: r.providerId || null, status: status, reason: r.reason || null };
      }
    };
  }

  // ---- an OPTIONAL HTTP relay adapter factory (server holds the secret) ------
  // This is how Twilio/SendGrid/SMTP/etc. plug in — as ONE adapter each, posting
  // to a server function. Not registered by default (no vendor lock-in).
  function httpAdapter(name, channels, providerKey) {
    return {
      name: name, channels: (channels || []).slice(), capabilities: { send: true, inbound: false, status: true },
      async send(message) {
        const endpoint = cfg().transportEndpoint || '/api/transport-send';
        const res = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: providerKey || name, channel: message.channel, to: message.to, subject: message.subject || null, body: message.body })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || !data.ok) { const e = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status)); e.code = data && data.error; throw e; }
        return { ok: true, providerId: data.providerId || null, via: name };
      }
    };
  }

  // channel -> ordered adapter names (primary first, then fallbacks).
  const REGISTRY = {};       // name -> adapter
  const CHAINS = {};         // channel -> [name, ...]

  function valid(a) { return a && typeof a.name === 'string' && Array.isArray(a.channels) && typeof a.send === 'function'; }

  const Adapters = {
    CHANNELS: CHANNELS,
    httpAdapter: httpAdapter,
    localAdapter: localAdapter,

    /** Register (or replace) an adapter. Auto-joins the chain for each of its
     *  channels if that channel has no chain yet (so the first registered
     *  adapter becomes the default pipe — no hard-coded vendor). */
    register(adapter, opts) {
      if (!valid(adapter)) return { ok: false, error: 'INVALID_ADAPTER' };
      const o = opts || {};
      REGISTRY[adapter.name] = adapter;
      adapter.channels.forEach((ch) => {
        if (CHANNELS.indexOf(ch) === -1) return;
        const chain = CHAINS[ch] || (CHAINS[ch] = []);
        if (chain.indexOf(adapter.name) === -1) { if (o.primary) chain.unshift(adapter.name); else chain.push(adapter.name); }
      });
      return { ok: true, adapter: adapter.name };
    },

    get(name) { return REGISTRY[name] || null; },
    list() { return Object.keys(REGISTRY).map((n) => REGISTRY[n]); },
    names() { return Object.keys(REGISTRY); },

    /** Ordered adapters to try for a channel (resolved from names). */
    for(channel) { return (CHAINS[channel] || []).map((n) => REGISTRY[n]).filter(Boolean); },
    /** Set the exact ordered chain for a channel (by adapter name). */
    setChain(channel, names) { CHAINS[channel] = (names || []).filter((n) => REGISTRY[n]); return { ok: true, chain: CHAINS[channel].slice() }; },
    addFallback(channel, name) { if (!REGISTRY[name]) return { ok: false, error: 'UNKNOWN_ADAPTER' }; (CHAINS[channel] = CHAINS[channel] || []).push(name); return { ok: true }; },
    chains() { const out = {}; Object.keys(CHAINS).forEach((c) => { out[c] = CHAINS[c].slice(); }); return out; },

    /** Provider chains in the shape AAA_TRANSPORT.processQueue expects. */
    sendChains() { const out = {}; CHANNELS.forEach((c) => { out[c] = this.for(c); }); return out; },

    /** Find the adapter that can parse an inbound payload for a channel. */
    inboundAdapter(channel, name) {
      if (name && REGISTRY[name] && REGISTRY[name].parseInbound) return REGISTRY[name];
      return this.for(channel).find((a) => typeof a.parseInbound === 'function') || (REGISTRY.local || null);
    },

    /** Reset to just the local pipe (used by tests / a clean install). */
    reset() { Object.keys(REGISTRY).forEach((k) => delete REGISTRY[k]); Object.keys(CHAINS).forEach((k) => delete CHAINS[k]); this.register(localAdapter()); return { ok: true }; }
  };

  // Default install: the LOCAL pipe only. Real adapters are registered by the
  // app/owner at boot — Twilio/SendGrid/etc. are opt-in, never assumed.
  Adapters.register(localAdapter());

  global.AAA_TRANSPORT_ADAPTERS = Adapters;
})(typeof window !== 'undefined' ? window : this);
