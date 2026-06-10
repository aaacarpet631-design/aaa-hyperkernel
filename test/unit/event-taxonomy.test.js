/* Event Taxonomy — the 25 highest-value business events: classification, bus
 * registration, contract enforcement, and no-drift against the committed manifest. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('event-taxonomy');
  const { G } = setupEnv();
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  load('js/core/aaa-event-taxonomy.js');
  const TAX = G.AAA_EVENT_TAXONOMY;
  const BUS = G.AAA_EVENT_BUS;

  // ===== exactly 25, unique, well-formed =====
  const cat = TAX.catalog();
  t.eq('defines exactly 25 events', cat.length, 25);
  const types = cat.map((e) => e.type);
  t.eq('all event types are unique', new Set(types).size, 25);
  t.ok('every event has the five classification axes', cat.every((e) =>
    e.domain && e.stage && e.primitive && typeof e.reversible === 'boolean' && e.risk && e.description && e.schema));
  t.ok('every type is domain.action', cat.every((e) => /^[a-z]+\.[a-z]+$/.test(e.type)));
  t.ok('risk is low|medium|high', cat.every((e) => ['low', 'medium', 'high'].indexOf(e.risk) !== -1));

  // ===== the five primitives are closed and all represented =====
  const FIVE = ['Decision', 'Entity', 'Event', 'Memory', 'Relationship'];
  t.eq('exactly the five closed primitives are used', JSON.stringify(TAX.primitives()), JSON.stringify(FIVE));
  t.ok('every primitive is represented at least once', FIVE.every((p) => TAX.byPrimitive(p).length >= 1));

  // ===== the three learning-loop closers exist (no discarded signal) =====
  t.ok('estimate loop resolves to won/lost/expired', !!(TAX.get('quote.accepted') && TAX.get('quote.rejected') && TAX.get('quote.expired')));
  t.ok('recommendation loop has create + validate', !!(TAX.get('recommendation.created') && TAX.get('recommendation.validated')));
  t.ok('outcome.recorded closes the prediction loop', TAX.get('outcome.recorded').primitive === 'Memory');

  // ===== classification helpers =====
  t.ok('byStage(sales) returns the estimate lifecycle', TAX.byStage('sales').length === 6);
  t.ok('byDomain(payment) groups payment events', TAX.byDomain('payment').length === 2);
  t.ok('high-risk events exist and include billing/governance', TAX.byRisk('high').some((e) => e.type === 'payment.received') && TAX.byRisk('high').some((e) => e.type === 'decision.recorded'));

  // ===== registers all 25 as bus contracts (additive over the seeds) =====
  const reg = TAX.register();
  t.ok('register() reports 25 registered', reg.ok === true && reg.registered === 25);
  t.ok('all 25 are live bus contracts', types.every((ty) => !!BUS.contract(ty)));

  // ===== contract enforcement flows through the bus (no fake success) =====
  const good = await BUS.publish('payment.received', { paymentId: 'p1', invoiceId: 'i1', amount: 950 }, { actor: 'controller' });
  t.ok('a valid taxonomy event publishes + chains', good.ok === true && !!good.event.hash);
  const bad = await BUS.publish('payment.received', { invoiceId: 'i1' }); // missing required paymentId
  t.ok('a schema-invalid taxonomy event is rejected, not logged', bad.ok === false && bad.error === 'SCHEMA_INVALID');
  const badEnum = await BUS.publish('quote.sent', { quoteId: 'q1', channel: 'smoke_signal' });
  t.ok('enum violations on a taxonomy event are caught', badEnum.ok === false && badEnum.issues.some((i) => /channel/.test(i)));

  // ===== no-drift: committed manifest matches the live taxonomy =====
  const fs = require('fs'); const path = require('path');
  const live = TAX.manifest();
  t.eq('manifest counts 25', live.count, 25);
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'event-taxonomy.json'), 'utf8'));
  t.eq('committed event-taxonomy.json matches the live taxonomy (no drift)', JSON.stringify(committed), JSON.stringify(live));

  // ===== determinism: manifest is stable across reloads =====
  const { G: G2 } = setupEnv();
  load('js/core/aaa-events.js'); load('js/core/aaa-event-bus.js'); load('js/core/aaa-event-taxonomy.js');
  t.eq('manifest is deterministic', JSON.stringify(G2.AAA_EVENT_TAXONOMY.manifest()), JSON.stringify(live));

  return t.report();
};
