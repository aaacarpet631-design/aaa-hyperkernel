/* Native Event Bus — contracts, validation, immutable chained log, subscribe, bridge, tamper. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('event-bus');
  const { G, data } = setupEnv();
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  const BUS = G.AAA_EVENT_BUS;
  const EV = G.AAA_EVENTS;

  // ===== contracts catalog =====
  t.ok('ships seeded contracts (AsyncAPI-style)', BUS.contracts().length >= 4 && !!BUS.contract('quote.created'));
  t.eq('unknown event type is rejected', (await BUS.publish('nope.event', {})).error, 'UNKNOWN_EVENT_TYPE');

  // ===== validation: no drift, no fake success =====
  const bad = await BUS.publish('quote.created', { total: 'lots' }); // missing quoteId, wrong type
  t.ok('schema-invalid payload is rejected with issues', bad.ok === false && bad.error === 'SCHEMA_INVALID' && bad.issues.length >= 1);
  t.eq('a rejected event is NOT logged', (await BUS.log()).length, 0);
  const badEnum = await BUS.publish('quote.sent', { quoteId: 'q1', channel: 'carrier_pigeon' });
  t.ok('enum violations are caught', badEnum.ok === false && badEnum.issues.some((i) => /channel/.test(i)));

  // ===== publish + subscribe + immutable chained log =====
  let got = null;
  BUS.subscribe('quote.created', (payload, rec) => { got = { payload: payload, seq: rec.seq }; });
  const p1 = await BUS.publish('quote.created', { quoteId: 'q1', customerId: 'c1', total: 500 }, { actor: 'estimator' });
  t.ok('valid event publishes + is logged', p1.ok === true && p1.event.seq === 1 && !!p1.event.hash);
  t.ok('subscriber received the typed event', got && got.payload.quoteId === 'q1' && got.seq === 1);
  const p2 = await BUS.publish('job.closed', { jobId: 'j1', outcome: 'won' });
  t.ok('second event chains onto the first', p2.event.seq === 2 && p2.event.prevHash === p1.event.hash);

  // ===== chain integrity + tamper detection =====
  const chain = await BUS.verifyChain();
  t.ok('event chain verifies intact', chain.ok === true && chain.length === 2 && chain.breaks.length === 0);
  const victim = await BUS.get(p1.event.id);
  await data.put('event_log', victim.id, Object.assign({}, victim, { payload: { quoteId: 'HACKED', total: 999999 } }));
  const broken = await BUS.verifyChain();
  t.ok('tampering an event is detected', broken.ok === false && broken.breaks.some((b) => b.reason === 'hash_mismatch'));
  await data.put('event_log', victim.id, victim); // restore

  // ===== log read + analytics =====
  t.ok('log lists newest first + filters by type', (await BUS.log())[0].seq === 2 && (await BUS.log({ type: 'job.closed' })).length === 1);
  const an = await BUS.analytics();
  t.ok('analytics summarizes the log', an.total === 2 && an.byType['quote.created'] === 1 && an.contracts >= 4);

  // ===== bridge: existing AAA_EVENTS emits mirror into the typed log =====
  const before = (await BUS.log({ type: 'comm.inbound' })).length;
  EV.emit('comm.inbound', { id: 'in1', threadId: 'thr1' });
  await new Promise((r) => setTimeout(r, 0)); // let the async bridge publish settle
  t.ok('a bridged AAA_EVENTS emit is captured as a typed event', (await BUS.log({ type: 'comm.inbound' })).length === before + 1);

  // ===== pluggable transport: external broker is an OPTIONAL dumb pipe =====
  const forwarded = [];
  BUS.setTransport({ name: 'test-pipe', publish: (type, ev) => { forwarded.push({ type: type, seq: ev.seq }); } });
  t.eq('a transport can be plugged in (provider-neutral)', BUS.transport(), 'test-pipe');
  const fp = await BUS.publish('job.closed', { jobId: 'j2', outcome: 'lost' });
  t.ok('published events are forwarded to the transport', fp.ok === true && forwarded.some((f) => f.type === 'job.closed' && f.seq === fp.event.seq));
  // a failing transport must NOT break publish or the local log (offline-safe)
  BUS.setTransport({ name: 'broken', publish: () => { throw new Error('broker down'); } });
  const resilient = await BUS.publish('job.closed', { jobId: 'j3', outcome: 'won' });
  t.ok('a transport failure never breaks the local publish/log', resilient.ok === true && (await BUS.get(resilient.event.id)) !== null);
  BUS.setTransport(null);
  t.eq('transport detaches cleanly (default in-app only)', BUS.transport(), null);

  // ===== AsyncAPI export stays in sync with the committed schema file =====
  const fs = require('fs'); const path = require('path');
  const doc = BUS.asyncapi();
  t.ok('asyncapi() emits a valid AsyncAPI 2.6 doc with a channel per contract', doc.asyncapi === '2.6.0' && Object.keys(doc.channels).length === BUS.contracts().length && !!doc.channels['quote.created']);
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'asyncapi', 'aaa-events.asyncapi.json'), 'utf8'));
  t.eq('committed AsyncAPI file matches the live contracts (no drift)', JSON.stringify(committed.channels), JSON.stringify(doc.channels));

  // ===== determinism: identical payloads → identical chain hash position =====
  const { G: G2, data: d2 } = setupEnv();
  load('js/core/aaa-events.js'); load('js/core/aaa-event-bus.js');
  const a = await G2.AAA_EVENT_BUS.publish('quote.created', { quoteId: 'qx', customerId: 'c', total: 1 });
  const { G: G3 } = setupEnv();
  load('js/core/aaa-events.js'); load('js/core/aaa-event-bus.js');
  const b = await G3.AAA_EVENT_BUS.publish('quote.created', { quoteId: 'qx', customerId: 'c', total: 1 });
  t.eq('chain hash is deterministic for identical input', a.event.hash, b.event.hash);

  return t.report();
};
