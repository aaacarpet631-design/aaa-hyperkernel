/* Pricing hard rules — $45/room shampoo floor + stair multiplier. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('pricing');
  const { G, cfg } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  const Q = G.AAA_MEASUREMENT_QUOTE, M = G.AAA_MEASUREMENT_MODELS;
  const tiny = () => [M.newSession({ roomName: 'A', length: 5, width: 5 })]; // 25 sqft

  cfg.set({ rateCard: { min_job: 0 } }); // isolate shampoo floor from trip minimum
  t.eq('shampoo 1 room = $45', Q.priceService('carpet_shampoo', tiny()).subtotal, 45);
  cfg.set({ rateCard: { min_job: 0, shampoo_per_sqft: 0 } });
  t.eq('floor holds at $0/ft2', Q.priceService('carpet_shampoo', tiny()).subtotal, 45);
  cfg.set({ rateCard: { min_job: 0, shampoo_min_per_room: 60 } });
  t.eq('owner raises floor to $60', Q.priceService('carpet_shampoo', tiny()).subtotal, 60);
  cfg.set({ rateCard: { min_job: 0, shampoo_min_per_room: 10 } });
  t.eq('cannot go below $45 hard floor', Q.priceService('carpet_shampoo', tiny()).subtotal, 45);

  cfg.set({ rateCard: {} });
  const threeRooms = ['a', 'b', 'c'].map((n) => M.newSession({ roomName: n, length: 5, width: 5 }));
  t.eq('3 rooms floor $135 beats $95 trip min', Q.priceService('carpet_shampoo', threeRooms).subtotal, 135);
  t.ok('big room not floored', Q.priceService('carpet_shampoo', [M.newSession({ roomName: 'big', length: 40, width: 40 })]).subtotal > 45);

  const st = Q.priceService('stairs', [M.newSession({ roomName: 's', stairsCount: 10 })]); // 10*6*1.5=90
  t.eq('stairs labor x1.5 applied', st._labor, 90);
  t.ok('stairs rule note present', st._ruleNotes.some((n) => /stair labor/.test(n)));

  return t.report();
};
