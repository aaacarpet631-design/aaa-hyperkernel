/* Template registry — renders every message type, customer-safe, null-tolerant. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('transport-templates');
  const { G } = setupEnv({ config: { businessName: 'AAA Carpet' } });
  load('js/transport/template-registry.js');
  const R = G.AAA_TEMPLATES;

  const ALL = ['quote_ready', 'quote_reminder', 'quote_followup', 'appointment_confirmation', 'on_the_way', 'job_completion', 'review_request_24h', 'review_reminder_7d', 'missed_call_textback', 'photo_quote_ack'];
  t.eq('all message types registered', R.list().length, ALL.length);

  let allOk = true, allSafe = true, noUndefined = true;
  ALL.forEach((id) => {
    const r = R.render(id, { customerName: 'Jane', quoteRange: '$1,200–$1,500', quoteUrl: 'http://x', apptDate: 'Tue 9am', techName: 'Sam', eta: '20 min', reviewUrl: 'http://r' });
    if (!r.ok || !r.body) allOk = false;
    if (/labor|margin|\bcost\b|internal|confidence|risk/i.test((r.subject || '') + ' ' + r.body)) allSafe = false;
    if (/undefined|\[object/.test(r.body)) noUndefined = false;
  });
  t.ok('every template renders a body', allOk);
  t.ok('templates are customer-safe (no internal terms)', allSafe);
  t.ok('templates never leak undefined', noUndefined);

  // Personalization + business name.
  const qr = R.render('quote_ready', { customerName: 'Jane', quoteRange: '$1,200–$1,500' });
  t.ok('renders name + business + range', /Jane/.test(qr.body) && /AAA Carpet/.test(qr.body) && /1,200/.test(qr.body));
  t.ok('email template has a subject', !!qr.subject);

  // Null-tolerant: missing vars degrade gracefully.
  const bare = R.render('quote_ready', {});
  t.ok('missing vars degrade to a default greeting', bare.ok && /there/.test(bare.body) && !/undefined/.test(bare.body));

  // Channel metadata + unknown template.
  t.eq('sms-only template channel', R.channelOf('missed_call_textback'), 'sms');
  t.eq('unknown template handled', R.render('nope', {}).error, 'UNKNOWN_TEMPLATE');

  return t.report();
};
