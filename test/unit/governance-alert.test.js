/*
 * governance-alert Netlify function — pure-logic unit tests (no network).
 *
 * Exercises env validation, PII-free email rendering, provider request building
 * (resend/postmark/sendgrid + unsupported), and provider response parsing
 * (success + failure). The .mjs is loaded via dynamic import; Netlify ignores
 * the non-default exports.
 */
'use strict';
const path = require('path');
const { makeRunner, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('governance-alert');
  const lib = await import(path.join(ROOT, 'netlify/functions/governance-alert.mjs'));

  // ---- validateEnv (missing env) -----------------------------------------
  t.eq('missing all → MISSING_CONFIG', lib.validateEnv({}).error, 'MISSING_CONFIG');
  t.ok('lists every missing var', lib.validateEnv({}).missing.length === 4);
  const fullEnv = { GOVERNANCE_ALERT_EMAIL_TO: 'owner@aaa.com', GOVERNANCE_ALERT_EMAIL_FROM: 'alerts@aaa.com', GOVERNANCE_ALERT_EMAIL_PROVIDER: 'resend', GOVERNANCE_ALERT_EMAIL_API_KEY: 're_123' };
  t.ok('full env ok', lib.validateEnv(fullEnv).ok === true);
  t.ok('one missing flagged', lib.validateEnv(Object.assign({}, fullEnv, { GOVERNANCE_ALERT_EMAIL_API_KEY: '' })).missing[0] === 'GOVERNANCE_ALERT_EMAIL_API_KEY');

  // ---- buildEmailContent: includes required governance fields -------------
  const payload = {
    escalationId: 'gesc_drift_x', kind: 'drift_override', domain: 'content_safety', category: 'S2',
    count: 4, threshold: 3, affectedCaseIds: ['gov_1', 'gov_2'], recommendedAction: 'Recalibrate the S2 classifier.',
    dashboardUrl: 'https://app.example.com/intel', priority: 'high'
  };
  const c = lib.buildEmailContent(payload);
  t.ok('subject has domain/category + counts', /content_safety\/S2/.test(c.subject) && /4 ≥ 3/.test(c.subject));
  ['content_safety', 'S2', 'gov_1', 'gov_2', 'Recalibrate the S2 classifier.', 'https://app.example.com/intel'].forEach((needle) => {
    t.ok('email body includes ' + needle, c.text.indexOf(needle) !== -1);
  });
  t.ok('threshold + count present', c.text.indexOf('4') !== -1 && c.text.indexOf('3') !== -1);

  // ---- NO PII LEAKAGE: customer fields are dropped, not rendered ----------
  const withPII = Object.assign({}, payload, {
    customerName: 'Jane Doe', phone: '555-123-4567', email: 'jane@home.com',
    message: 'Hi Jane, thanks for your business at 12 Oak St!', draft: 'secret draft'
  });
  const c2 = lib.buildEmailContent(withPII);
  const blob = c2.subject + '\n' + c2.text + '\n' + c2.html;
  ['Jane Doe', '555-123-4567', 'jane@home.com', '12 Oak St', 'secret draft'].forEach((pii) => {
    t.ok('PII excluded: ' + pii, blob.indexOf(pii) === -1);
  });
  t.ok('governance metadata still present', blob.indexOf('S2') !== -1 && blob.indexOf('gov_1') !== -1);

  // ---- buildProviderRequest (success shapes) ------------------------------
  const r1 = lib.buildProviderRequest('resend', fullEnv, c);
  t.ok('resend → resend API + bearer', r1.ok && r1.url.indexOf('resend.com') !== -1 && r1.headers.authorization === 'Bearer re_123');
  t.ok('resend body has from/to/subject', r1.body.from === 'alerts@aaa.com' && r1.body.to === 'owner@aaa.com' && !!r1.body.subject);
  const r2 = lib.buildProviderRequest('postmark', fullEnv, c);
  t.ok('postmark → token header', r2.ok && r2.headers['X-Postmark-Server-Token'] === 're_123' && r2.body.From === 'alerts@aaa.com');
  const r3 = lib.buildProviderRequest('sendgrid', fullEnv, c);
  t.ok('sendgrid → personalizations', r3.ok && Array.isArray(r3.body.personalizations) && r3.body.personalizations[0].to[0].email === 'owner@aaa.com');
  const r4 = lib.buildProviderRequest('mailchimp', fullEnv, c);
  t.eq('unknown provider rejected', r4.error, 'UNSUPPORTED_PROVIDER');

  // ---- parseProviderResponse (success + provider failure) -----------------
  t.ok('resend 200 → ok + id', lib.parseProviderResponse('resend', 200, { id: 'em_1' }).ok === true);
  t.eq('resend 200 captures id', lib.parseProviderResponse('resend', 200, { id: 'em_1' }).id, 'em_1');
  t.ok('postmark 200 → MessageID', lib.parseProviderResponse('postmark', 200, { MessageID: 'pm_9' }).id === 'pm_9');
  const fail = lib.parseProviderResponse('resend', 422, { message: 'invalid from address' });
  t.ok('provider failure → not ok', fail.ok === false && fail.status === 422);
  t.ok('provider failure carries message', /invalid from/.test(fail.message));

  return t.report();
};
