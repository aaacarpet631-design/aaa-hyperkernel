/*
 * AAA SMS Copilot Adapter — transport-neutral SMS ↔ Executive Copilot.
 *
 * handleInbound({from, body}) authenticates the sender (owner-only), routes the
 * message through the Executive Copilot, formats a short reply, sends it via a
 * pluggable PROVIDER, and logs both the inbound and outbound to the Event Bus
 * (the immutable record). No SMS provider is hardcoded: setProvider() accepts a
 * Twilio/Telnyx/native adapter ({ name, send(to, body) }); a local mock is the
 * default so it runs with zero credentials. SMS inherits all Copilot governance
 * — a protected action returns an approval-required reply, never an action.
 */
;(function (global) {
  'use strict';

  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function bus() { return global.AAA_EVENT_BUS; }
  function router() { return global.AAA_SMS_COMMAND_ROUTER; }
  function formatter() { return global.AAA_SMS_RESPONSE_FORMATTER; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  // Default provider: a credential-free mock that records what it "sent".
  const mockProvider = { name: 'mock', sent: [], async send(to, body) { this.sent.push({ to: to, body: body, at: nowISO() }); return { ok: true, provider: 'mock' }; } };
  let PROVIDER = mockProvider;

  function defineContracts() {
    const b = bus();
    if (!b || b.contract('sms.received')) return;
    b.define('sms.received', { version: 1, description: 'An inbound SMS to the Executive Copilot.', schema: { type: 'object', required: ['from'], properties: { from: { type: 'string' }, authorized: { type: 'boolean' }, intent: { type: 'string' } } } });
    b.define('sms.sent', { version: 1, description: 'An outbound SMS reply from the Executive Copilot.', schema: { type: 'object', required: ['to'], properties: { to: { type: 'string' }, length: { type: 'number' }, governanceRequired: { type: 'boolean' } } } });
  }
  async function emit(type, payload) { try { if (bus() && bus().contract(type)) await bus().publish(type, payload, { source: 'sms_copilot' }); } catch (_) {} }

  const Adapter = {
    /** Plug a provider adapter ({ name, send(to, body) }). Pass null to restore the mock. */
    setProvider(p) { PROVIDER = (p && typeof p.send === 'function') ? p : mockProvider; return { ok: true, provider: PROVIDER.name || 'custom' }; },
    provider() { return PROVIDER ? (PROVIDER.name || 'custom') : null; },
    mock: mockProvider,

    /**
     * Handle an inbound text. Returns { authorized, response?, answer? }.
     * Unauthorized numbers are logged and rejected — not routed, not replied to
     * (to avoid messaging unknown numbers). Authorized messages are answered.
     */
    async handleInbound(inbound) {
      defineContracts();
      const m = inbound || {};
      const r = router() ? await router().route(m) : { authorized: false, reason: 'NO_ROUTER' };
      const intent = r.answer && r.answer.intent;
      await emit('sms.received', { from: String(m.from || ''), authorized: !!r.authorized, intent: intent || null });

      if (!r.authorized) {
        await emit('sms.blocked', {});
        return { authorized: false, reason: r.reason || 'UNKNOWN_NUMBER' };
      }
      const text = formatter() ? formatter().format(r.answer, m.opts) : String((r.answer && r.answer.answer && r.answer.answer.summary) || 'Done.');
      let sendResult = null;
      try { sendResult = await PROVIDER.send(m.from, text); } catch (e) { sendResult = { ok: false, error: e && e.message }; }
      await emit('sms.sent', { to: String(m.from || ''), length: text.length, governanceRequired: !!(r.answer && r.answer.governanceRequired) });
      return { authorized: true, response: text, answer: r.answer, sent: sendResult };
    }
  };

  global.AAA_SMS_COPILOT_ADAPTER = Adapter;
})(typeof window !== 'undefined' ? window : this);
