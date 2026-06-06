/* Expense classifier — deterministic vendor rules, honest unknowns, learning. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('expense-classifier');
  const { G } = setupEnv();
  load('js/accounting/expense-classifier.js');
  const C = G.AAA_EXPENSE_CLASSIFIER;

  // Known vendors map to the right category at high confidence.
  const homeDepot = await C.classify({ vendor: 'THE HOME DEPOT #6818' });
  t.eq('Home Depot -> Materials', homeDepot.category, 'Materials');
  t.ok('Home Depot confident', homeDepot.confidence >= 90 && !homeDepot.needsReview);
  t.ok('Home Depot explains itself', typeof homeDepot.reasoning === 'string' && homeDepot.reasoning.length > 0);

  t.eq('Chevron -> Fuel', (await C.classify({ vendor: 'Chevron' })).category, 'Fuel');
  t.eq('Floor & Decor -> Inventory', (await C.classify({ vendor: 'Floor & Decor' })).category, 'Inventory');
  t.eq('Harbor Freight -> Tools', (await C.classify({ vendor: 'Harbor Freight Tools' })).category, 'Tools');
  t.eq('Staples -> Office', (await C.classify({ vendor: 'Staples' })).category, 'Office');
  t.eq('Google Ads -> Advertising', (await C.classify({ vendor: 'Google Ads' })).category, 'Advertising');
  t.eq('Twilio -> Communications', (await C.classify({ vendor: 'Twilio' })).category, 'Communications');
  t.eq('OpenAI -> Software', (await C.classify({ vendor: 'OpenAI' })).category, 'Software');

  // Unknown vendor: honest — low confidence, Uncategorized, needs a human.
  const unknown = await C.classify({ vendor: 'Joe\'s Random Shop' });
  t.eq('unknown -> Uncategorized', unknown.category, 'Uncategorized');
  t.ok('unknown needs review', unknown.needsReview === true && unknown.confidence < C.REVIEW_THRESHOLD);
  t.ok('unknown offers candidates', Array.isArray(unknown.candidates) && unknown.candidates.length > 0);

  // No vendor at all -> lowest confidence.
  const blank = await C.classify({ vendor: '' });
  t.ok('blank vendor lowest confidence', blank.confidence <= unknown.confidence && blank.needsReview);

  // Line-item keyword heuristic when the vendor is unknown.
  const byItems = await C.classify({ vendor: 'Unknown Hardware LLC', lineItems: ['Seam tape', 'Carpet pad'] });
  t.eq('keyword items -> Materials', byItems.category, 'Materials');
  t.eq('keyword source', byItems.source, 'keyword');

  // Learning: a human correction sticks and wins next time at high confidence.
  const corr = await C.correct({ vendor: 'Joe\'s Random Shop', category: 'Subcontractors', actor: 'owner' });
  t.ok('correction accepted', corr.ok === true);
  const relearned = await C.classify({ vendor: "JOE'S RANDOM SHOP" });
  t.eq('learned category wins', relearned.category, 'Subcontractors');
  t.eq('learned source', relearned.source, 'learned');
  t.ok('learned high confidence', relearned.confidence >= 95 && !relearned.needsReview);

  // Bad correction rejected.
  t.eq('reject unknown category', (await C.correct({ vendor: 'X', category: 'NotACategory' })).error, 'UNKNOWN_CATEGORY');

  // Accuracy tracking: log a prediction, then resolve it via a correction.
  const pred = await C.logPrediction({ vendor: 'Test Vendor', predicted: 'Materials', confidence: 92, source: 'vendor-rule' });
  await C.correct({ vendor: 'Test Vendor', category: 'Tools', predictionId: pred.id });
  const acc = await C.accuracy();
  t.ok('accuracy tracks resolved', acc.resolved >= 1 && acc.accuracyPct != null);
  t.ok('learned vendors counted', acc.learnedVendors >= 2);

  return t.report();
};
