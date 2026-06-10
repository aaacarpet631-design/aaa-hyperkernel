/*
 * governance-alert — Netlify Function: owner/admin EMAIL delivery for
 * high-priority governance escalations.
 *
 * The client (AAA_GOVERNANCE_NOTIFIER) POSTs a PII-free escalation summary; this
 * function renders it and sends one email via the configured provider. It is
 * deliberately small and provider-pluggable (resend | postmark | sendgrid) so a
 * future SMS/push function can follow the same shape without touching the
 * escalation engine.
 *
 * The PURE helpers (validateEnv, buildEmailContent, buildProviderRequest,
 * parseProviderResponse, json) are named exports so they can be unit-tested
 * offline; Netlify ignores the non-default exports at deploy time.
 *
 * Env:
 *   GOVERNANCE_ALERT_EMAIL_TO        recipient (owner/admin)
 *   GOVERNANCE_ALERT_EMAIL_FROM      verified sender
 *   GOVERNANCE_ALERT_EMAIL_PROVIDER  resend | postmark | sendgrid
 *   GOVERNANCE_ALERT_EMAIL_API_KEY   provider API key
 *
 * PII rule: only governance metadata is ever emailed (domain, category, counts,
 * governance case IDs, recommended action, dashboard link). Never a customer
 * name/phone/email or the drafted message.
 */

// Only these keys are ever rendered into an email. Anything else on the payload
// (e.g. a stray customer field) is dropped by construction.
const ALLOWED = ['domain', 'category', 'count', 'threshold', 'affectedCaseIds', 'recommendedAction', 'dashboardUrl', 'priority', 'kind', 'escalationId', 'metric', 'value', 'detail', 'severity'];

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS'
    }
  });
}

export function validateEnv(env) {
  const missing = [];
  if (!env.GOVERNANCE_ALERT_EMAIL_TO) missing.push('GOVERNANCE_ALERT_EMAIL_TO');
  if (!env.GOVERNANCE_ALERT_EMAIL_FROM) missing.push('GOVERNANCE_ALERT_EMAIL_FROM');
  if (!env.GOVERNANCE_ALERT_EMAIL_PROVIDER) missing.push('GOVERNANCE_ALERT_EMAIL_PROVIDER');
  if (!env.GOVERNANCE_ALERT_EMAIL_API_KEY) missing.push('GOVERNANCE_ALERT_EMAIL_API_KEY');
  return missing.length ? { ok: false, error: 'MISSING_CONFIG', missing } : { ok: true };
}

// PII-free email content from an allowlisted payload. Returns { subject, text, html }.
export function buildEmailContent(raw) {
  const p = {};
  ALLOWED.forEach((k) => { if (raw && raw[k] != null) p[k] = raw[k]; });
  const ids = Array.isArray(p.affectedCaseIds) ? p.affectedCaseIds : [];
  const priority = (p.priority || 'high').toUpperCase();
  const subject = '[AAA Governance] ' + priority + ' — ' + (p.domain || 'governance') + '/' + (p.category || 'unknown') +
    ' (' + (p.count != null ? p.count : '?') + ' ≥ ' + (p.threshold != null ? p.threshold : '?') + ')';

  const lines = [
    'A high-priority governance escalation was raised.',
    '',
    'Priority:        ' + priority,
    'Kind:            ' + (p.kind || 'drift_override'),
    'Domain:          ' + (p.domain || '—'),
    'Category:        ' + (p.category || '—'),
    'Override count:  ' + (p.count != null ? p.count : '—'),
    'Metric:          ' + (p.metric != null ? p.metric + ' = ' + (p.value != null ? p.value : '—') : '—'),
    'Threshold:       ' + (p.threshold != null ? p.threshold : '—'),
    'Detail:          ' + (p.detail != null ? p.detail : '—'),
    'Affected cases:  ' + (ids.length ? ids.join(', ') : '—'),
    '',
    'Recommended action:',
    (p.recommendedAction || 'Review the affected cases in the governance dashboard.'),
  ];
  if (p.dashboardUrl) { lines.push('', 'Dashboard: ' + p.dashboardUrl); }
  lines.push('', 'This message contains governance metadata only — no customer information.');
  const text = lines.join('\n');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">' +
    '<h2 style="margin:0 0 8px">⚠ Governance escalation — ' + esc(priority) + '</h2>' +
    '<table style="border-collapse:collapse">' +
    [['Kind', p.kind || 'drift_override'], ['Domain', p.domain], ['Category', p.category],
      ['Override count', p.count], ['Threshold', p.threshold], ['Affected cases', ids.join(', ')]]
      .map((r) => '<tr><td style="padding:2px 12px 2px 0;color:#666">' + esc(r[0]) + '</td><td><strong>' + esc(r[1] == null ? '—' : r[1]) + '</strong></td></tr>').join('') +
    '</table>' +
    '<p style="margin:12px 0 4px"><strong>Recommended action</strong></p><p style="margin:0">' + esc(p.recommendedAction || 'Review the affected cases in the governance dashboard.') + '</p>' +
    (p.dashboardUrl ? '<p style="margin:12px 0"><a href="' + esc(p.dashboardUrl) + '">Open governance dashboard →</a></p>' : '') +
    '<p style="margin:12px 0 0;color:#999;font-size:12px">Governance metadata only — no customer information.</p></div>';

  return { subject, text, html };
}

// Translate (provider, env, content) → a single HTTP request descriptor.
export function buildProviderRequest(provider, env, content) {
  const to = env.GOVERNANCE_ALERT_EMAIL_TO;
  const from = env.GOVERNANCE_ALERT_EMAIL_FROM;
  const key = env.GOVERNANCE_ALERT_EMAIL_API_KEY;
  switch (String(provider || '').toLowerCase()) {
    case 'resend':
      return { ok: true, url: 'https://api.resend.com/emails',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: { from, to, subject: content.subject, text: content.text, html: content.html } };
    case 'postmark':
      return { ok: true, url: 'https://api.postmarkapp.com/email',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': key },
        body: { From: from, To: to, Subject: content.subject, TextBody: content.text, HtmlBody: content.html, MessageStream: 'outbound' } };
    case 'sendgrid':
      return { ok: true, url: 'https://api.sendgrid.com/v3/mail/send',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: { personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject: content.subject,
          content: [{ type: 'text/plain', value: content.text }, { type: 'text/html', value: content.html }] } };
    default:
      return { ok: false, error: 'UNSUPPORTED_PROVIDER', provider };
  }
}

// Normalize a provider HTTP response into { ok, id?, error? }.
export function parseProviderResponse(provider, status, data) {
  if (status >= 200 && status < 300) {
    const id = data && (data.id || data.MessageID || data.message_id) || null;
    return { ok: true, id, status };
  }
  const msg = data && (data.message || data.Message || (data.errors && JSON.stringify(data.errors))) || ('HTTP ' + status);
  return { ok: false, error: 'PROVIDER_ERROR', status, message: String(msg) };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const env = process.env;
  const v = validateEnv(env);
  if (!v.ok) return json(v, 500);

  let payload;
  try { payload = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }

  const content = buildEmailContent(payload || {});
  const reqDesc = buildProviderRequest(env.GOVERNANCE_ALERT_EMAIL_PROVIDER, env, content);
  if (!reqDesc.ok) return json(reqDesc, 400);

  try {
    const res = await fetch(reqDesc.url, { method: 'POST', headers: reqDesc.headers, body: JSON.stringify(reqDesc.body) });
    let data = null; try { data = await res.json(); } catch (_) { /* some providers return empty body */ }
    const parsed = parseProviderResponse(env.GOVERNANCE_ALERT_EMAIL_PROVIDER, res.status, data || {});
    return json(parsed, parsed.ok ? 200 : 502);
  } catch (err) {
    return json({ ok: false, error: 'DELIVERY_FAILED', message: String((err && err.message) || err) }, 502);
  }
};

export const config = { path: '/api/governance-alert' };
