/*
 * AAA_OUTCOME_SPINE — outcome normalization + additive overlay unit tests.
 *
 * Covers normalization of generic / quote / lead source records, defensive
 * handling of malformed records, validation (incl. quote/job MAPE-required
 * fields), unlabeled()/coverage(), result-class mapping, and the outcome_labels
 * overlay: write-to-overlay-only, merge-at-read-time, no source mutation,
 * durable re-hydrate, and the missing-actor guard. No network, no mutation.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('outcome-spine');
  const { G, data } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });

  // Seed source records across fragmented stores.
  await data.put('outcomes', 'o1', { id: 'o1', jobId: 'j1', result: 'won', estimatedAmount: 480, finalAmount: 500, marginPct: 22, recordedAt: 1000, customerId: 'c1' });
  await data.put('outcomes', 'bad', null); // malformed — must not crash

  const sourceQuotes = [
    { quoteId: 'q1', status: 'lost', customerTotal: 300, finalPrice: 0, marginPct: 18, wonLostReason: 'price', updatedAt: 1000, customerId: 'c2' },
    { quoteId: 'q2', status: 'won' }, // missing amounts → MAPE fields should surface as missing
    {}, // malformed
    null // malformed
  ];
  const sourceLeads = [
    { leadId: 'l1', source: 'google', serviceType: 'carpet', outcome: { result: 'LOST', lostReason: 'budget', at: 1000 } }
  ];
  G.AAA_QUOTES = { list: async () => sourceQuotes };
  G.AAA_LEADS = { list: async () => sourceLeads };

  load('js/intelligence/outcome-spine.js');
  const S = G.AAA_OUTCOME_SPINE;
  t.ok('global exists', !!S);
  S._resetOverlayCache();

  // ---- normalize per source -------------------------------------------------
  const nGeneric = S.normalize({ id: 'o1', jobId: 'j1', result: 'won', estimatedAmount: 480, finalAmount: 500, recordedAt: 1000 }, 'outcomes');
  t.eq('normalize generic: entityType job', nGeneric.entityType, 'job');
  t.eq('normalize generic: entityId from jobId', nGeneric.entityId, 'j1');
  t.eq('normalize generic: resultClass success', nGeneric.resultClass, 'success');

  const nQuote = S.normalize({ quoteId: 'q1', status: 'lost', customerTotal: 300, finalPrice: 280 }, 'quotes');
  t.eq('normalize quote: entityType quote', nQuote.entityType, 'quote');
  t.eq('normalize quote: estimatedAmount from customerTotal', nQuote.estimatedAmount, 300);
  t.eq('normalize quote: finalAmount from finalPrice', nQuote.finalAmount, 280);
  t.eq('normalize quote: resultClass failure', nQuote.resultClass, 'failure');

  const nLead = S.normalize({ leadId: 'l1', source: 'google', outcome: { result: 'WON', revenue: 900, at: 1 } }, 'leads');
  t.eq('normalize lead: entityType lead', nLead.entityType, 'lead');
  t.eq('normalize lead: result from outcome', nLead.resultClass, 'success');
  t.eq('normalize lead: finalAmount from revenue', nLead.finalAmount, 900);

  // ---- malformed safety -----------------------------------------------------
  let threw = false;
  try { S.normalize(null, 'quotes'); S.normalize(undefined, 'outcomes'); S.normalize(42, 'leads'); } catch (_) { threw = true; }
  t.ok('malformed records do not crash', !threw);

  // ---- validation -----------------------------------------------------------
  const vMissing = S.validate({ entityType: 'job' });
  t.eq('validate detects missing required', vMissing.ok, false);
  t.ok('validate lists missing result', vMissing.missing.indexOf('result') !== -1);

  const vQuoteNoAmounts = S.validate({ entityType: 'quote', entityId: 'q2', result: 'won', resultClass: 'success', recordedAt: 1 });
  t.ok('quote MAPE fields surface as missing', vQuoteNoAmounts.missing.indexOf('estimatedAmount') !== -1 && vQuoteNoAmounts.missing.indexOf('finalAmount') !== -1);

  // ---- result normalization -------------------------------------------------
  t.eq('result map: won → success', S.classifyResult('won'), 'success');
  t.eq('result map: lost → failure', S.classifyResult('lost'), 'failure');
  t.eq('result map: abandoned → failure', S.classifyResult('abandoned'), 'failure');
  t.eq('result map: callback → neutral', S.classifyResult('callback'), 'neutral');
  t.eq('result map: gibberish → unknown', S.classifyResult('zzz'), 'unknown');

  // ---- list / unlabeled / coverage -----------------------------------------
  const all = await S.list();
  t.ok('list reads across sources', all.length >= 3);
  const unl = await S.unlabeled();
  t.ok('unlabeled returns incomplete records (q2 has no amounts)', unl.some((r) => r.entityId === 'q2'));

  const cov = await S.coverage();
  t.eq('coverage total counts normalized outcomes', cov.total, all.length);
  t.ok('coverage labeled+unlabeled == total', cov.labeled + cov.unlabeled === cov.total);
  t.ok('coverage missingByField tallies', cov.missingByField && typeof cov.missingByField === 'object');

  // ---- overlay: missing actor rejected -------------------------------------
  const noActor = await S.label('quote', 'q2', { estimatedAmount: 1000, finalAmount: 1100 });
  t.eq('missing actor rejected', noActor.error, 'ACTOR_REQUIRED');

  // ---- overlay: write-only + merge-at-read ----------------------------------
  const labeled = await S.label('quote', 'q2', { estimatedAmount: 1000, finalAmount: 1100, recordedAt: 2000, reason: 'manual backfill' }, 'owner@test');
  t.eq('label succeeds with actor', labeled.ok, true);

  // overlay merges at read time
  const afterList = await S.list({ entityType: 'quote' });
  const q2 = afterList.find((r) => r.entityId === 'q2');
  t.eq('overlay merges estimatedAmount at read', q2.estimatedAmount, 1000);
  t.eq('overlay merges finalAmount at read', q2.finalAmount, 1100);
  t.eq('overlay records labeledBy', q2.labeledBy, 'owner@test');

  // overlay wrote ONLY to outcome_labels — source untouched
  t.ok('overlay persisted to outcome_labels only', !!data._store.outcome_labels && Object.keys(data._store.outcome_labels).length === 1);
  const rawQ2 = sourceQuotes.find((q) => q && q.quoteId === 'q2');
  t.eq('source quote q2 not mutated (no estimatedAmount)', rawQ2.estimatedAmount, undefined);
  t.eq('source quote q2 not mutated (status intact)', rawQ2.status, 'won');
  t.ok('no write-back to quotes/outcomes for q2', !(data._store.quotes) && !(data._store.outcomes && data._store.outcomes.q2));

  // re-label updates the SAME overlay entry (no duplicates)
  await S.label('quote', 'q2', { reason: 'second pass' }, 'owner@test');
  t.eq('re-label does not duplicate overlay entries', Object.keys(data._store.outcome_labels).length, 1);

  // durable: drop cache, re-hydrate from the overlay collection, still merged
  S._resetOverlayCache();
  const rehydrated = (await S.list({ entityType: 'quote' })).find((r) => r.entityId === 'q2');
  t.eq('overlay re-hydrates from store', rehydrated.estimatedAmount, 1000);

  return t.report();
};
