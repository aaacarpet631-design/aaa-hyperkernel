/*
 * Transport status webhook (Netlify) — Twilio + SendGrid delivery callbacks.
 *
 *   POST /api/transport-webhook?provider=twilio    (Twilio status callback,
 *        application/x-www-form-urlencoded: MessageSid, MessageStatus, ...)
 *   POST /api/transport-webhook?provider=sendgrid   (SendGrid event webhook,
 *        application/json: [{ sg_message_id, event, reason }, ...])
 *
 * It normalizes each event to { providerId, status(delivered|bounced|failed),
 * reason } and persists them to a durable status feed (Netlify Blobs) that the
 * client transport store drains and applies (via AAA_TRANSPORT.applyStatusEvent)
 * to update delivery truth + the immutable per-message history.
 *
 * No secrets are exposed. Unknown/intermediate statuses are ignored. The
 * normalization mirrors AAA_TRANSPORT.normalizeProviderEvent on the client.
 */
import { createHash } from 'node:crypto';
import { boundedBody, appEnv } from '../lib/app-auth.mjs';
import { errorResponse } from '../lib/openai.mjs';
import { verifyWebhook } from '../lib/webhook-auth.mjs';

const FEED = 'comms-status-events';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function normTwilio(p) {
  const map = { delivered: 'delivered', undelivered: 'bounced', failed: 'failed' };
  const status = map[String(p.MessageStatus || '').toLowerCase()] || 'ignored';
  return { provider: 'twilio', providerId: p.MessageSid || p.SmsSid || null, status, reason: p.ErrorMessage || (p.ErrorCode ? 'code ' + p.ErrorCode : null) };
}
function normSendgrid(p) {
  const map = { delivered: 'delivered', bounce: 'bounced', blocked: 'bounced', dropped: 'failed' };
  const status = map[String(p.event || '').toLowerCase()] || 'ignored';
  return { provider: 'sendgrid', providerId: p.sg_message_id || p.smtp_id || null, status, reason: p.reason || p.response || null };
}


export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  const provider = new URL(req.url).searchParams.get('provider');
  if (provider !== 'twilio' && provider !== 'sendgrid') return json({ ok: false, error: 'UNKNOWN_PROVIDER' }, 400);

  try {
    const raw = Buffer.from(await boundedBody(req, 1024 * 1024));
    verifyWebhook(req, raw, appEnv());
    let events;
    if (provider === 'sendgrid') {
      let values;
      try { values = JSON.parse(raw.toString('utf8')); } catch (_) { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
      if (!Array.isArray(values) || values.length > 1000 || values.some(v => !v || typeof v !== 'object' || Array.isArray(v))) return json({ ok: false, error: 'INVALID_EVENTS' }, 400);
      events = values.map(normSendgrid);
    } else events = [normTwilio(Object.fromEntries(new URLSearchParams(raw.toString('utf8'))))];
    const actionable = events.filter(e => e.status !== 'ignored' && typeof e.providerId === 'string' && e.providerId.length <= 500);
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: FEED, consistency: 'strong' });
    let stored = 0;
    for (const event of actionable) {
      const key = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const result = await store.setJSON(key, { receivedAt: new Date().toISOString(), ...event }, { onlyIfNew: true });
      if (result.modified) stored++;
    }
    // Storage failure must be retried by the provider, not acknowledged as a
    // delivered status that was never persisted.
    return json({ ok: true, received: events.length, actionable: actionable.length, stored });
  } catch (err) { return errorResponse(err); }

};

export const config = { path: '/api/transport-webhook' };
