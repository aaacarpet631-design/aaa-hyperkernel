/* Field Capture Session + Field Brain — START MEASUREMENT → capture rooms →
 * aggregate into one quote draft (sqft, 12-ft material plan, waste, stairs,
 * labor, priced range) → attach to a job. Job-optional, keyboard-free,
 * reuses the measurement store + pricing engine, mutates no job record. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/measurements/models/measurement-models.js', 'js/measurements/storage/measurement-store.js',
   'js/quotes/integrations/measurement-to-quote.js',
   'js/measurements/field-brain.js', 'js/measurements/field-capture-session.js'].forEach(load);
}

module.exports = async function run() {
  const t = makeRunner('field-capture-session');
  const { G, data } = setupEnv();
  loadAll();
  const FCS = G.AAA_FIELD_CAPTURE_SESSION, BRAIN = G.AAA_FIELD_BRAIN;

  // ===== Field Brain pure calculators =====
  const agg = BRAIN.aggregate([{ length: 15, width: 18 }, { squareFeet: 80 }, { stairsCount: 12 }]);
  t.ok('aggregate sums sqft from L×W and explicit sqft', agg.totalSquareFeet === 15 * 18 + 80 && agg.totalStairs === 12 && agg.roomCount === 3);
  t.eq('empty aggregate is insufficient_data', BRAIN.aggregate([]).status, 'insufficient_data');
  const plan = BRAIN.materialPlan(270, {});
  t.ok('12-ft material plan adds waste and reports running feet', plan.rollWidthFt === 12 && plan.squareFeetWithWaste === 297 && plan.linearFeet12ftRoll === Math.ceil(297 / 12));
  const labor = BRAIN.laborHours(270, 12, {});
  t.ok('labor hours is an honest estimate', labor.status === 'estimate' && labor.hours > 0);
  t.ok('serviceSelections adds a stairs line when stairs exist', BRAIN.serviceSelections([{ length: 10, width: 10, stairsCount: 3 }], {}).some(function (s) { return s.serviceId === 'stairs'; }));

  // ===== session lifecycle =====
  const sess = await FCS.start({ customerId: 'c1' });
  t.ok('a job-optional session starts in capturing state', sess.status === 'capturing' && sess.jobId === null && !!sess.id);

  await FCS.addRoom(sess.id, { roomName: 'Living', length: 15, width: 18 });
  await FCS.addRoom(sess.id, { roomName: 'Hall', length: 4, width: 20 });
  const r3 = await FCS.addRoom(sess.id, { roomName: 'Stairs', stairsCount: 12 });
  t.ok('rooms are captured into the session', r3.ok === true && (await FCS.get(sess.id)).roomIds.length === 3);
  t.eq('captured rooms are retrievable', (await FCS.rooms(sess.id)).length, 3);

  // ===== aggregation (the Field Brain view) =====
  const sum = await FCS.summarize(sess.id);
  t.ok('summary aggregates sqft + stairs across rooms', sum.totalSquareFeet === 15 * 18 + 4 * 20 && sum.totalStairs === 12);
  t.ok('summary carries the material plan + labor estimate', sum.materialPlan.linearFeet12ftRoll > 0 && sum.labor.hours > 0);

  // ===== one aggregated quote draft, reusing the pricing engine =====
  const draft = await FCS.buildQuoteDraft(sess.id, { service: 'carpet_install' });
  t.ok('a single quote draft is built across all rooms', draft.status === 'drafted' && draft.quote && draft.quote.total > 0);
  t.ok('the quote always needs review (never auto-finalized)', draft.quote.needsReview === true && draft.needsReview === true);
  t.ok('the draft is stored on the session', (await FCS.get(sess.id)).status === 'quoted' && !!(await FCS.get(sess.id)).quote);

  // ===== honest empty case =====
  const empty = await FCS.start({});
  t.eq('a session with no rooms cannot fake a quote', (await FCS.buildQuoteDraft(empty.id, {})).status, 'insufficient_data');

  // ===== attach to a job (links field data; no job-record mutation) =====
  const before = JSON.stringify({ jobs: data._store.jobs || {} });
  const attached = await FCS.attachToJob(sess.id, 'job_42');
  t.ok('attaching links the session + rooms to the job', attached.ok === true && (await FCS.get(sess.id)).jobId === 'job_42' && (await FCS.rooms(sess.id)).every(function (r) { return r.jobId === 'job_42'; }));
  t.ok('attach returns estimate entries for the caller to persist', Array.isArray(attached.estimateEntries) && attached.estimateEntries.length >= 1);
  t.eq('attaching mutates no job business record', JSON.stringify({ jobs: data._store.jobs || {} }), before);

  return t.report();
};
