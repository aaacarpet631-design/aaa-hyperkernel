/* sense-normalize — offline unit test (self-contained; no harness, no network). */
'use strict';
const { normalize } = require('./sense-normalize.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

// Twilio inbound SMS
const sms = normalize({ MessageSid: 'SM123', From: '+15551112222', To: '+15559990000', Body: 'is tomorrow ok?' });
ok('inbound SMS recognized', sms.ok && sms.event.type === 'inbound_sms');
eq('SMS externalId = MessageSid', sms.event.externalId, 'SM123');
ok('SMS payload mapped', sms.event.payload.from === '+15551112222' && /tomorrow/.test(sms.event.payload.body) && sms.event.source === 'twilio');

// Twilio missed call
const miss = normalize({ CallSid: 'CA9', From: '+15551112222', To: '+15559990000', CallStatus: 'no-answer' });
ok('missed call recognized', miss.ok && miss.event.type === 'missed_call' && miss.event.externalId === 'CA9');
const answered = normalize({ CallSid: 'CA10', CallStatus: 'completed' });
eq('a completed call is NOT a missed-call signal', answered.error, 'NOT_A_MISSED_CALL');

// Web lead
const lead = normalize({ name: 'Jane Doe', phone: '+15551112222', email: 'jane@x.com', message: 'need a quote', submittedAt: '2026-06-07' });
ok('web lead recognized', lead.ok && lead.event.type === 'web_lead' && lead.event.source === 'web_form');
ok('lead payload mapped', lead.event.payload.name === 'Jane Doe' && lead.event.payload.phone === '+15551112222');
ok('lead has a stable externalId', typeof lead.event.externalId === 'string' && lead.event.externalId.length > 0);

// Already-normalized passthrough
const pass1 = normalize({ type: 'inbound_sms', externalId: 'X1', payload: { from: '+1', body: 'hi' } });
ok('normalized signal passes through', pass1.ok && pass1.event.type === 'inbound_sms' && pass1.event.externalId === 'X1');

// Unknown
eq('unknown payload rejected', normalize({ foo: 'bar' }).error, 'UNRECOGNIZED');

console.log('sense-normalize: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
