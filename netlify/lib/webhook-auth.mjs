/* Provider signatures are checked over the original URL/body before parsing. */
import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { OpenAIError } from './openai.mjs';

export function verifyWebhook(req, rawBody, env, now = Date.now()) {
  const provider = new URL(req.url).searchParams.get('provider');
  if (provider === 'twilio') {
    if (!env.TWILIO_AUTH_TOKEN) throw new OpenAIError('WEBHOOK_AUTH_NOT_CONFIGURED', 503);
    // Configure this exact public callback URL if the hosting proxy rewrites
    // req.url. Never trust forwarded host headers supplied by the requester.
    const url = env.TWILIO_STATUS_CALLBACK_URL || req.url;
    const fields = new URLSearchParams(rawBody.toString('utf8'));
    let signed = url;
    for (const key of [...new Set(fields.keys())].sort()) {
      for (const value of [...new Set(fields.getAll(key))].sort()) signed += key + value;
    }
    const expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(signed).digest();
    const actual = Buffer.from(req.headers.get('x-twilio-signature') || '', 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new OpenAIError('INVALID_WEBHOOK_SIGNATURE', 403);
  } else if (provider === 'sendgrid') {
    if (!env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY) throw new OpenAIError('WEBHOOK_AUTH_NOT_CONFIGURED', 503);
    const timestamp = req.headers.get('x-twilio-email-event-webhook-timestamp') || '';
    // Providers sign each delivery attempt. Reject stale requests, while a
    // deterministic event key below makes valid redelivery idempotent.
    if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new OpenAIError('INVALID_WEBHOOK_TIMESTAMP', 403);
    try {
      const key = createPublicKey({ key: Buffer.from(env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
      const signature = Buffer.from(req.headers.get('x-twilio-email-event-webhook-signature') || '', 'base64');
      if (!verify('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), key, signature)) throw new Error('signature');
    } catch (_) { throw new OpenAIError('INVALID_WEBHOOK_SIGNATURE', 403); }
  } else throw new OpenAIError('UNKNOWN_PROVIDER');
  return provider;
}
