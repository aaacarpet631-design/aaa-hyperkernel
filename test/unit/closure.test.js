/* 9-point closure engine — before/after photo evidence detection. */
'use strict';
const { makeRunner } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('closure');
  const G = global; G.window = G;
  const store = { jobs: {}, mediaCache: {} };
  G.AAA_LOCAL_FIRST_STORAGE = {
    get: (c, id) => store[c][id] || null,
    getAll: (c) => Object.values(store[c] || {})
  };
  delete require.cache[require.resolve('../../js/ai/sidekick-closure-engine.js')];
  require('../../js/ai/sidekick-closure-engine.js');
  const CE = G.AAA_SIDEKICK_CLOSURE;

  store.jobs.j1 = { id: 'j1', estimates: [{ estimateId: 'e1' }], notes: 'did work' };
  let rep = await CE.auditJobFile('j1');
  t.ok('no photos -> before false', rep.autoVerified.beforePhotos === false);
  t.ok('no photos -> after false', rep.autoVerified.afterPhotos === false);

  store.mediaCache.m1 = { jobId: 'j1' };
  rep = await CE.auditJobFile('j1');
  t.ok('1 photo -> before true, after false', rep.autoVerified.beforePhotos === true && rep.autoVerified.afterPhotos === false);

  store.mediaCache.m2 = { jobId: 'j1' };
  rep = await CE.auditJobFile('j1');
  t.ok('2 photos -> before & after', rep.autoVerified.beforePhotos && rep.autoVerified.afterPhotos);

  store.jobs.j2 = { id: 'j2', estimates: [{}], notes: 'x' };
  store.mediaCache.b = { jobId: 'j2', type: 'BEFORE' };
  rep = await CE.auditJobFile('j2');
  t.ok('tagged BEFORE only -> after still false', rep.autoVerified.beforePhotos === true && rep.autoVerified.afterPhotos === false);

  return t.report();
};
