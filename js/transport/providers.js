/*
 * AAA Transport Providers — SMS/email provider abstraction.
 *
 * The store talks to providers through this seam, never to Twilio/SendGrid
 * directly. The default providers POST to the server-side /api/transport-send
 * function (secrets live in the Netlify env, NEVER in the browser). Each channel
 * can have a primary + fallback provider; the queue tries them in order.
 *
 * A provider is { name, async send(message) -> { ok, providerId } | throws }.
 * Tests inject mock providers — no network required.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function endpoint() { return (cfg().transportEndpoint) || '/api/transport-send'; }

  function httpProvider(name, providerKey) {
    return {
      name: name,
      async send(message) {
        const res = await fetch(endpoint(), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: providerKey, channel: message.channel, to: message.to, subject: message.subject || null, body: message.body })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || !data.ok) { const e = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status)); e.code = data && data.error; throw e; }
        return { ok: true, providerId: data.providerId || null };
      }
    };
  }

  // channel -> ordered providers (primary first, then fallbacks).
  const CHAINS = {
    sms: [httpProvider('twilio', 'twilio')],
    email: [httpProvider('sendgrid', 'sendgrid')]
  };

  const Providers = {
    /** Ordered providers to try for a channel. */
    for(channel) { return (CHAINS[channel] || []).slice(); },
    /** Register / override providers for a channel (primary first). */
    set(channel, list) { CHAINS[channel] = Array.isArray(list) ? list.slice() : []; },
    /** Append a fallback provider for a channel. */
    addFallback(channel, provider) { (CHAINS[channel] = CHAINS[channel] || []).push(provider); }
  };

  global.AAA_TRANSPORT_PROVIDERS = Providers;
})(typeof window !== 'undefined' ? window : this);
