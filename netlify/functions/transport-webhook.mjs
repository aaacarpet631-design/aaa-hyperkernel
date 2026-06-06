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
import { getStore } from '@netlify/blobs';

const FEED = 'comms-status-events';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

async function parse(provider, req) {
  if (provider === 'sendgrid') {
    const arr = await req.json().catch(() => []);
    return (Array.isArray(arr) ? arr : []).map(normSendgrid);
  }
  // Twilio posts urlencoded
  const text = await req.text().catch(() => '');
  const form = Object.fromEntries(new URLSearchParams(text));
  return [normTwilio(form)];
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  const provider = new URL(req.url).searchParams.get('provider');
  if (provider !== 'twilio' && provider !== 'sendgrid') return json({ ok: false, error: 'UNKNOWN_PROVIDER' }, 400);

  let events;
  try { events = await parse(provider, req); } catch (e) { return json({ ok: false, error: 'PARSE_FAILED' }, 400); }
  const actionable = events.filter((e) => e && e.status && e.status !== 'ignored' && e.providerId);

  // Persist actionable events for the client to drain + apply. Best-effort.
  let stored = 0;
  try {
    const store = getStore(FEED);
    for (const e of actionable) {
      const key = e.providerId + ':' + e.status + ':' + Date.now();
      await store.setJSON(key, Object.assign({ receivedAt: new Date().toISOString() }, e));
      stored++;
    }
  } catch (err) { console.warn('status feed unavailable', err); }

  // Always ack 2xx so providers don't hammer retries.
  return json({ ok: true, received: events.length, actionable: actionable.length, stored });
};

export const config = { path: '/api/transport-webhook' };
