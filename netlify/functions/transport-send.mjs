/*
 * Transport send function (Netlify) — the server-side SMS/email dispatcher.
 *
 * Secrets live ONLY here (Netlify site env), never in the browser:
 *   SMS   (Twilio):   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *   Email (SendGrid): SENDGRID_API_KEY, SENDGRID_FROM
 *
 * POST { provider, channel, to, subject?, body } -> { ok, providerId } | error.
 * Returns a stable NOT_CONFIGURED error (no secret leakage) until env is set, so
 * the client queue degrades to retry/fallback rather than crashing.
 *
 * NOTE: governance (review-before-send, human-only approval, audit) is enforced
 * client-side in AAA_TRANSPORT before anything reaches this function. This
 * function only performs the already-approved dispatch.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { ok: false, error: 'NOT_CONFIGURED', message: 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.' };
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: { 'authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: 'PROVIDER_ERROR', message: (data && data.message) || ('Twilio HTTP ' + res.status) };
  return { ok: true, providerId: data.sid || null };
}

async function sendEmail(to, subject, body) {
  const key = process.env.SENDGRID_API_KEY, from = process.env.SENDGRID_FROM;
  if (!key || !from) return { ok: false, error: 'NOT_CONFIGURED', message: 'Set SENDGRID_API_KEY, SENDGRID_FROM.' };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject: subject || '(no subject)', content: [{ type: 'text/plain', value: body }] })
  });
  if (!(res.status >= 200 && res.status < 300)) { const data = await res.json().catch(() => ({})); return { ok: false, error: 'PROVIDER_ERROR', message: (data && data.errors && data.errors[0] && data.errors[0].message) || ('SendGrid HTTP ' + res.status) }; }
  return { ok: true, providerId: res.headers.get('x-message-id') || null };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  const channel = body && body.channel, to = body && body.to;
  if (!to) return json({ ok: false, error: 'NO_RECIPIENT' }, 400);
  try {
    const r = channel === 'sms' ? await sendSms(to, body.body || '')
      : channel === 'email' ? await sendEmail(to, body.subject, body.body || '')
      : { ok: false, error: 'BAD_CHANNEL' };
    return json(r, r.ok ? 200 : (r.error === 'NOT_CONFIGURED' ? 503 : 502));
  } catch (err) {
    console.error('transport-send error', err);
    return json({ ok: false, error: 'SEND_FAILED', message: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: '/api/transport-send' };
