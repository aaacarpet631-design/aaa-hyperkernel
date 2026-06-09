/*
 * sense-normalize — pure translation of provider webhook payloads into the one
 * normalized signal shape the sensing layer ingests:
 *     { type, externalId, source, payload }
 *
 * No network, no env, no SDK — so the webhook handler (which holds any signing
 * secret) reuses it and it is unit-tested offline. Recognizes Twilio inbound SMS,
 * Twilio voice missed-call status callbacks, and a generic web-lead form; an
 * already-normalized { type, externalId, payload } passes through.
 */
'use strict';

const MISSED = ['no-answer', 'busy', 'failed', 'no_answer', 'missed'];

function str(v) { return v == null ? '' : String(v); }

function normalize(payload, opts) {
  const p = payload || {};
  const o = opts || {};

  // Already-normalized signal.
  if (p.type && (p.externalId || p.payload)) {
    return { ok: true, event: { type: String(p.type), externalId: p.externalId ? String(p.externalId) : null, source: p.source || o.source || 'app', payload: p.payload || {} } };
  }

  // Twilio inbound SMS.
  if (p.MessageSid && (p.Body != null || p.From)) {
    return { ok: true, event: { type: 'inbound_sms', externalId: String(p.MessageSid), source: 'twilio', payload: { from: str(p.From), to: str(p.To), body: str(p.Body) } } };
  }

  // Twilio voice status callback → a missed call.
  if (p.CallSid && p.CallStatus) {
    if (MISSED.indexOf(String(p.CallStatus).toLowerCase()) === -1) return { ok: false, error: 'NOT_A_MISSED_CALL', status: p.CallStatus };
    return { ok: true, event: { type: 'missed_call', externalId: String(p.CallSid), source: 'twilio', payload: { from: str(p.From), to: str(p.To), status: str(p.CallStatus) } } };
  }

  // Generic web-lead form.
  if (p.name || p.phone || p.email) {
    const ext = p.id || p.leadId || ('lead_' + (str(p.phone) || str(p.email)) + '_' + (p.submittedAt || ''));
    return { ok: true, event: { type: 'web_lead', externalId: String(ext), source: p.source || 'web_form', payload: { name: str(p.name), phone: str(p.phone), email: str(p.email), message: str(p.message) } } };
  }

  return { ok: false, error: 'UNRECOGNIZED' };
}

module.exports = { normalize };
