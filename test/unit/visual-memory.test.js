/* Visual Memory — the moat layer: every image becomes a structured evidence
 * record linked to the real business outcome, with evidence-driven retrieval.
 *
 * Guards the contract that makes it honest: analysis is stored verbatim and
 * NEVER fabricated (absent fields → null); customer PII never leaks into
 * retrieval aggregates; outcome stats only count records that actually have a
 * linked outcome; and nothing throws when the stores are absent. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('visual-memory');
  const { G } = setupEnv();
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/visual-memory-store.js');
  const VM = G.AAA_VISUAL_MEMORY, PROV = G.AAA_PROVENANCE;

  // ===== record: structured, traceable, no fabrication =====
  const r1 = await VM.record({
    jobId: 'j1', customerId: 'c1', quoteId: 'q1', imageRef: 'media_1', source: 'vision',
    serviceType: ['stretch'], zip: '77001',
    analysis: { category: 'PET_DAMAGE', recommendation: 'Stretch + seam', confidenceScore: 0.82, estimateLowUSD: 250, estimateHighUSD: 350 }
  });
  t.ok('record returns a stored record with id + capturedAt', !!r1.id && !!r1.capturedAt);
  t.ok('record persists into the collection', (await VM.list()).length === 1);
  t.eq('analysis category stored verbatim', r1.analysis.category, 'PET_DAMAGE');
  t.eq('confidence stored verbatim', r1.analysis.confidenceScore, 0.82);
  t.ok('consent defaults to false (PII-safe)', r1.consent === false);
  t.ok('a provenance trace was written for the image', (await PROV.forSubject('visual_evidence', r1.id)).length === 1);

  // ===== no fabrication: absent analysis → nulls, never invented =====
  const bare = await VM.record({ jobId: 'j2', imageRef: 'media_2' });
  t.ok('missing analysis fields are null, not invented', bare.analysis.category === null && bare.analysis.confidenceScore === null && bare.analysis.estimateLowUSD === null);
  t.ok('consent honored when explicitly granted', (await VM.record({ jobId: 'j2', consent: true })).consent === true);

  // ===== linkOutcome: Phase-4 substrate =====
  const lo = await VM.linkOutcome(r1.id, { finalAmountUSD: 320, won: true, laborHours: 3 });
  t.ok('linkOutcome attaches the real outcome', lo.ok === true && lo.record.outcome.finalAmountUSD === 320 && lo.record.outcome.won === true);
  t.ok('linkOutcome on an unknown id fails honestly', (await VM.linkOutcome('nope', {})).ok === false);
  t.ok('get() returns the outcome-linked record', (await VM.get(r1.id)).outcome.laborHours === 3);

  // ===== seed a corpus of PET_DAMAGE with outcomes for retrieval =====
  const a = await VM.record({ jobId: 'j3', customerId: 'c3', imageRef: 'm3', serviceType: ['stretch'], zip: '77002', analysis: { category: 'PET_DAMAGE', estimateLowUSD: 200, estimateHighUSD: 300 } });
  await VM.linkOutcome(a.id, { finalAmountUSD: 280, won: true, laborHours: 2 });
  const b = await VM.record({ jobId: 'j4', customerId: 'c4', imageRef: 'm4', serviceType: ['stretch'], zip: '77003', analysis: { category: 'PET_DAMAGE', estimateLowUSD: 400, estimateHighUSD: 600 } });
  await VM.linkOutcome(b.id, { finalAmountUSD: 700, won: false, laborHours: 4 }); // lost; final above range
  await VM.record({ jobId: 'j5', imageRef: 'm5', serviceType: ['repair'], zip: '77004', analysis: { category: 'SEAM_SPLIT' } }); // different category, no outcome

  // ===== findSimilar: evidence-driven, PII-min, outcome-only aggregates =====
  const sim = await VM.findSimilar(r1.id);
  t.eq('findSimilar matches on category first', sim.matchedOn, 'category');
  t.ok('findSimilar finds the prior PET_DAMAGE records (excludes self)', sim.count === 2);
  t.ok('samples are PII-minimized — no customer fields leak', sim.samples.every((s) => !('customerId' in s) && !('customerName' in s) && !('jobId' in s)));
  t.eq('close rate aggregates only linked outcomes (1 won / 1 lost = 50%)', sim.outcomes.closeRatePct, 50);
  t.eq('avg final amount over outcomes ((280+700)/2)', sim.outcomes.avgFinalAmountUSD, 490);
  t.eq('only outcome-linked records count toward stats', sim.outcomes.withOutcome, 2);

  // widen to serviceType when category has no peers
  const wide = await VM.findSimilar({ category: 'NOPE', serviceType: ['repair'] });
  t.eq('findSimilar widens to serviceType when category misses', wide.matchedOn, 'serviceType');
  // honest empty
  const none = await VM.findSimilar({ category: 'GHOST', serviceType: ['ghost'], zip: '00000' });
  t.ok('findSimilar is honestly empty when nothing matches', none.ok === true && none.count === 0 && none.matchedOn === 'none' && none.outcomes.closeRatePct === null);

  // ===== predictionAccuracy: estimate vs reality =====
  // scored records w/ both range + final: r1(320 in 250-350 ✓), a(280 in 200-300 ✓), b(700 in 400-600 ✗)
  const acc = await VM.predictionAccuracy();
  t.eq('predictionAccuracy scores only range+final records', acc.sample, 3);
  t.eq('within-range share is 2/3 → 67%', acc.withinRangePct, 67);
  t.ok('avg absolute error is reported', typeof acc.avgAbsErrorUSD === 'number');
  // no scored records → honest zero
  const { G: G2 } = setupEnv();
  load('js/intelligence/visual-memory-store.js');
  t.ok('predictionAccuracy is honest zero with no data', (await G2.AAA_VISUAL_MEMORY.predictionAccuracy()).sample === 0);

  // ===== null-safety: no data layer / no provenance → never throws =====
  const savedData = G.AAA_DATA; delete G.AAA_DATA;
  let threw = null, res = null;
  try { res = await VM.record({ jobId: 'x' }); await VM.findSimilar('x'); await VM.predictionAccuracy(); } catch (e) { threw = e; }
  G.AAA_DATA = savedData;
  t.ok('record/findSimilar/predictionAccuracy survive a missing data layer', threw === null && res && res.ok === false);
  const savedProv = G.AAA_PROVENANCE; delete G.AAA_PROVENANCE;
  let threw2 = null;
  try { await VM.record({ jobId: 'y', imageRef: 'my' }); } catch (e) { threw2 = e; }
  G.AAA_PROVENANCE = savedProv;
  t.ok('record still works when the provenance ledger is absent', threw2 === null);

  return t.report();
};
