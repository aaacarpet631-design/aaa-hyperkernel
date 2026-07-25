/* Data Manager adapter + mock client — the contract layer between human-
 * released conversion export batches and Data-Manager-shaped requests.
 *
 * Guards proven here: only 'released' batches are consumable; the request
 * mapping is exact (exactly-one-click-id rule, verbatim case-sensitive
 * gbraid); invalid payloads are reported in rejected[] with reasons, never
 * silently dropped; dryRun writes an honestly-labeled mode:'fixture' record
 * and batch.transmitted stays false; the real-send path returns
 * TRANSPORT_NOT_IMPLEMENTED even with credentials set (no fake success); the
 * mock client is deterministic and rejects malformed requests; a missing data
 * layer is handled honestly. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-datamanager-client');
  const { G, cfg, data } = setupEnv();
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/ads/google-ads-datamanager-client.js');
  load('js/ads/google-ads-mock-client.js');
  const DM = G.AAA_ADS_DATAMANAGER, MOCK = G.AAA_ADS_MOCK_CLIENT;
  const AD = G.AAA_AD_ATTRIBUTION, CL = G.AAA_ADS_CONVERSIONS;

  cfg.set({ googleAdsCustomerId: '123-456-7890' });

  // ===== build a genuinely released batch via the real governed pipeline =====
  await AD.attach('l1', { gclid: 'GC-abc123', campaign: 'Repair-Houston', consent: 'granted' });
  await AD.attach('l2', { gbraid: 'GbRaId_MiXeD', campaign: 'Repair-iOS', consent: 'granted' });
  await CL.record('l1', 'JOB_WON', { valueUSD: 500 });
  await CL.record('l2', 'JOB_WON', { valueUSD: 250 });
  const rel = await CL.releaseExport({ actor: 'owner' });
  t.ok('fixture: owner releases a 2-payload batch (transmitted:false)',
    rel.ok && rel.batch.status === 'released' && rel.batch.transmitted === false && rel.batch.payloads.length === 2);

  // ===== only released batches are consumable =====
  const draft = { id: 'adsexp_draft', workspaceId: 'ws_test', status: 'draft', payloads: rel.batch.payloads, transmitted: false };
  await data.put('ads_conversion_exports', draft.id, draft);
  t.eq('a non-released batch is refused', (await DM.prepareRequests('adsexp_draft')).error, 'NOT_RELEASED');
  t.eq('dryRun refuses a non-released batch too', (await DM.dryRun('adsexp_draft')).error, 'NOT_RELEASED');
  t.eq('an unknown batch id is refused', (await DM.prepareRequests('nope')).error, 'BATCH_NOT_FOUND');
  t.eq('a missing batch id is refused', (await DM.prepareRequests(null)).error, 'NO_BATCH_ID');
  const foreign = { id: 'adsexp_other', workspaceId: 'ws_other', status: 'released', payloads: [], transmitted: false };
  await data.put('ads_conversion_exports', foreign.id, foreign);
  t.eq('another workspace\'s batch is invisible', (await DM.prepareRequests('adsexp_other')).error, 'BATCH_NOT_FOUND');

  // ===== request mapping is exact =====
  const prep = await DM.prepareRequests(rel.batch.id);
  t.ok('a released batch prepares cleanly (2 requests, 0 rejected)',
    prep.ok && prep.requests.length === 2 && prep.rejected.length === 0);
  const p1 = rel.batch.payloads.find((p) => p.gclid === 'GC-abc123');
  const r1 = prep.requests.find((r) => r.event.adIdentifiers.gclid === 'GC-abc123');
  t.ok('gclid request maps every field to the Data Manager shape',
    !!r1 && r1.destination === 'GOOGLE_ADS' && r1.accountId === '123-456-7890' &&
    r1.event.transactionId === p1.orderId && r1.event.eventTimestamp === p1.conversionTime &&
    r1.event.conversionAction === 'JOB_WON' && r1.event.value === 500 && r1.event.currency === 'USD');
  const r2 = prep.requests.find((r) => r.event.adIdentifiers.gbraid != null);
  t.eq('gbraid case is preserved VERBATIM (never lowercased)', r2 && r2.event.adIdentifiers.gbraid, 'GbRaId_MiXeD');
  t.ok('adIdentifiers carries exactly the one click id present',
    Object.keys(r1.event.adIdentifiers).length === 1 && Object.keys(r2.event.adIdentifiers).length === 1);

  // ===== invalid payloads are rejected with reasons, never dropped =====
  const bad = {
    id: 'adsexp_bad', workspaceId: 'ws_test', status: 'released', transmitted: false,
    payloads: [
      { orderId: 'o1', conversionTime: '2026-07-07T00:00:00Z', gclid: 'A', wbraid: 'B', conversionAction: 'JOB_WON', conversionValueUSD: 1 },
      { orderId: 'o2', conversionTime: '2026-07-07T00:00:00Z', conversionAction: 'JOB_WON', conversionValueUSD: 1 },
      { orderId: 'o3', gclid: 'C', conversionAction: 'JOB_WON', conversionValueUSD: 1 },
      { conversionTime: '2026-07-07T00:00:00Z', gclid: 'D', conversionAction: 'JOB_WON', conversionValueUSD: 1 },
      { orderId: 'o5', conversionTime: '2026-07-07T00:00:00Z', gclid: 'E', conversionAction: 'JOB_WON', conversionValueUSD: 9 }
    ]
  };
  await data.put('ads_conversion_exports', bad.id, bad);
  const badPrep = await DM.prepareRequests('adsexp_bad');
  t.ok('nothing is silently dropped: requests + rejected === payloads',
    badPrep.ok && badPrep.requests.length + badPrep.rejected.length === 5 && badPrep.requests.length === 1);
  const reasonFor = (orderId) => { const e = badPrep.rejected.find((x) => x.orderId === orderId); return e ? e.reasons.join(',') : null; };
  t.eq('two click ids → MULTIPLE_CLICK_IDS', reasonFor('o1'), 'MULTIPLE_CLICK_IDS');
  t.eq('no click id → NO_CLICK_ID', reasonFor('o2'), 'NO_CLICK_ID');
  t.eq('missing conversionTime → NO_CONVERSION_TIME', reasonFor('o3'), 'NO_CONVERSION_TIME');
  t.ok('missing orderId → NO_ORDER_ID (still reported, orderId null)',
    badPrep.rejected.some((x) => x.orderId === null && x.reasons.indexOf('NO_ORDER_ID') !== -1));

  // ===== dryRun: honest fixture, transmitted stays false =====
  const dry = await DM.dryRun(rel.batch.id, { note: 'demo' });
  t.ok('dryRun returns the fixture labeled mode:fixture',
    dry.ok && dry.fixture.mode === 'fixture' && dry.fixture.batchId === rel.batch.id &&
    dry.fixture.requests.length === 2 && dry.fixture.rejected.length === 0 && !!dry.fixture.createdAt);
  const storedFix = (data._store.ads_transmission_fixtures || {})[dry.fixture.id];
  t.ok('the fixture is persisted in ads_transmission_fixtures', !!storedFix && storedFix.workspaceId === 'ws_test');
  const batchAfterDry = await data.get('ads_conversion_exports', rel.batch.id);
  t.eq('dryRun NEVER flips batch.transmitted', batchAfterDry.transmitted, false);

  // ===== real send: no fake success, even with credentials =====
  t.eq('credentialsPresent() is false with no flag set', DM.credentialsPresent(), false);
  t.eq('send without credentials is refused honestly', (await DM.send(rel.batch.id)).error, 'NO_CREDENTIALS');
  cfg.set({ googleAdsCredentials: 'oauth-token-placeholder' });
  t.eq('credentialsPresent() sees the flag', DM.credentialsPresent(), true);
  const sent = await DM.send(rel.batch.id);
  t.eq('real send returns TRANSPORT_NOT_IMPLEMENTED even WITH credentials', sent.error, 'TRANSPORT_NOT_IMPLEMENTED');
  t.ok('send never claims success or transmission', sent.ok === false && sent.transmitted === false);
  const batchAfterSend = await data.get('ads_conversion_exports', rel.batch.id);
  t.eq('batch.transmitted stays false after a send attempt', batchAfterSend.transmitted, false);
  t.eq('send still refuses non-released batches', (await DM.send('adsexp_draft')).error, 'NOT_RELEASED');

  // ===== mock client: deterministic, shape-validating, clearly a mock =====
  const m1 = MOCK.accept(prep.requests);
  const m2 = MOCK.accept(JSON.parse(JSON.stringify(prep.requests)));
  t.ok('mock accepts well-formed requests', m1.ok && m1.mode === 'mock' && m1.accepted === 2 && m1.rejected === 0);
  t.eq('mock is deterministic: same input → byte-identical output', JSON.stringify(m1), JSON.stringify(m2));
  t.ok('mock receipts are content-seeded and labeled synthetic',
    m1.results.every((r) => r.status === 'accepted' && r.receiptId.indexOf('mockrcpt_') === 0) &&
    m1.results[0].receiptId !== m1.results[1].receiptId);
  const twoIds = JSON.parse(JSON.stringify(prep.requests[0]));
  twoIds.event.adIdentifiers.wbraid = 'W-1';
  const malformed = MOCK.accept([
    { destination: 'GOOGLE_ADS' }, { destination: 'FACEBOOK', event: prep.requests[0].event },
    { destination: 'GOOGLE_ADS', event: { transactionId: 'x', eventTimestamp: 'y', adIdentifiers: {} } },
    twoIds
  ]);
  t.ok('mock rejects malformed requests per-request with reasons',
    malformed.ok && malformed.accepted === 0 && malformed.rejected === 4 &&
    malformed.results[0].reason === 'NO_EVENT' && malformed.results[1].reason === 'BAD_DESTINATION' &&
    malformed.results[2].reason === 'NO_CLICK_ID' && malformed.results[3].reason === 'MULTIPLE_CLICK_IDS');
  t.eq('mock refuses a non-array input', MOCK.accept(null).error, 'REQUESTS_MUST_BE_ARRAY');
  t.eq('mock self-identifies as a mock (never a production transport)', MOCK.isMock, true);

  // ===== honest failure modes: no data layer =====
  const savedData = G.AAA_DATA; delete G.AAA_DATA;
  t.eq('prepareRequests with no store → NO_STORE', (await DM.prepareRequests(rel.batch.id)).error, 'NO_STORE');
  t.eq('dryRun with no store → NO_STORE', (await DM.dryRun(rel.batch.id)).error, 'NO_STORE');
  t.eq('send with no store → NO_STORE', (await DM.send(rel.batch.id)).error, 'NO_STORE');
  t.eq('healthCheck with no store is honest', (await DM.healthCheck()).error, 'NO_STORE');
  G.AAA_DATA = savedData;
  const health = await DM.healthCheck();
  t.ok('healthCheck reports fixtures and the missing transport honestly',
    health.ok && health.fixtures === 1 && health.transport === 'NOT_IMPLEMENTED');

  return t.report();
};
