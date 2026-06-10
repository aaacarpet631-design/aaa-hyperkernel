/* Spatial Event Ledger — edge-first SHA-256 sealing, immutable hash chain,
 * deterministic m→ft normalization, insufficient-geometry guard, volatile
 * staging vs committed nodes, physical/business separation, tamper detection,
 * and the non-blocking two-pass notarization seam. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('spatial-event-ledger');
  const { G, data } = setupEnv();
  load('js/governance/audit-ledger.js');     // reused sha256 + canonical
  load('js/core/spatial-event-ledger.js');
  const L = G.AAA_SPATIAL_LEDGER;

  // ===== edge-first commit + hash chain =====
  const c1 = await L.commit({ captureSessionId: 's1', roomId: 'r1', source: 'bluetooth_laser', measurementKind: 'length', value: 1, unit: 'm', capturedBy: 'installer_tyrell', provenanceId: 'disto:AA:BB' });
  t.ok('a reading commits to an immutable node', c1.ok === true && c1.event.eventType === 'MEASUREMENT_RECORDED' && c1.event.seq === 1);
  t.ok('node carries a full edge-computed hash set', !!c1.event.eventHash && !!c1.event.rawPayloadHash && c1.event.previousEventHash === L.GENESIS);
  t.ok('node is deep-frozen (immutable in memory)', Object.isFrozen(c1.event));

  // ===== deterministic m → ft normalization (4dp), no network =====
  t.ok('meters normalize to feet at 4dp', c1.event.normalizedUnit === 'ft' && Math.abs(c1.event.normalizedValue - 3.2808) < 0.0001);
  const cDet = await L.commit({ captureSessionId: 's1', roomId: 'rX', source: 'bluetooth_laser', measurementKind: 'length', value: 1, unit: 'm' });
  t.eq('the same raw payload yields the same rawPayloadHash (deterministic)', cDet.event.rawPayloadHash, c1.event.rawPayloadHash);

  // ===== chain links + verifies intact =====
  const c2 = await L.commit({ captureSessionId: 's1', roomId: 'r1', source: 'bluetooth_laser', measurementKind: 'width', value: 12, unit: 'ft' });
  t.ok('each node chains off the previous eventHash', c2.event.seq === 3 && c2.event.previousEventHash === cDet.event.eventHash);
  t.ok('the local chain verifies intact', (await L.verifyChain()).ok === true);

  // ===== physical truth, NOT business economics =====
  const keys = Object.keys(c1.event);
  t.ok('the node holds physical invariants', keys.indexOf('normalizedValue') !== -1 && keys.indexOf('rollWidthFt') !== -1 && c1.event.rollWidthFt === 12 && keys.indexOf('napDirection') !== -1);
  t.ok('the node holds NO business economics (price/waste/markup/margin/cost)', keys.every(function (k) { return !/price|waste|markup|margin|cost/i.test(k); }));

  // ===== volatile staging never enters the chain =====
  const before = (await L.events()).length;
  L.stage({ captureSessionId: 's1', roomId: 'r9', measurementKind: 'length', value: 14.7, unit: 'ft' });
  L.stage({ captureSessionId: 's1', roomId: 'r9', measurementKind: 'length', value: 14.9, unit: 'ft' }); // the dot trembling
  t.ok('streamed readings stage in memory, not the chain', Object.keys(L.staged('s1')).length >= 1 && (await L.events()).length === before);

  // ===== insufficient geometry is refused (never invented) =====
  const bad = await L.commit({ captureSessionId: 's1', roomId: 'r2', source: 'room_scan', measurementKind: 'polygon_point', geometryType: 'polygon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
  t.ok('a polygon with <3 points is insufficient_data + needsReview', bad.ok === false && bad.error === 'insufficient_data' && bad.needsReview === true);
  t.eq('the refused reading was NOT committed to the chain', (await L.events()).length, before);

  // ===== two-pass: edge seal (done) → network notarization (separate attestation) =====
  const not1 = await L.notarize(c1.event.eventId, 'server-sig-001');
  t.ok('notarization records a separate global signature', not1.ok === true && not1.notarization.eventId === c1.event.eventId);
  const stillFrozen = await L.get(c1.event.eventId);
  t.ok('the immutable node is NOT mutated by notarization (chain survives)', stillFrozen.eventHash === c1.event.eventHash && stillFrozen.notarized === false);
  t.ok('pending-notarization tracks the rest', (await L.pendingNotarization()).indexOf(c1.event.eventId) === -1 && (await L.pendingNotarization()).indexOf(c2.event.eventId) !== -1);

  // ===== tamper detection: altering any value breaks the chain =====
  const victim = await L.get(c1.event.eventId);
  await data.put(L.COLLECTION, victim.eventId, Object.assign({}, victim, { normalizedValue: 999.9 })); // installer tries to cover a short-cut roll
  const broken = await L.verifyChain();
  t.ok('a manually altered measurement is detected (hash mismatch)', broken.ok === false && broken.breaks.some(function (b) { return b.reason === 'hash_mismatch'; }));
  t.eq('a tampered node fails notarization too', (await L.notarize(victim.eventId, 'x')).error, 'TAMPER_DETECTED');
  await data.put(L.COLLECTION, victim.eventId, victim); // restore
  t.ok('restoring the true value re-verifies the chain', (await L.verifyChain()).ok === true);

  // ===== honest empty measurement =====
  t.eq('an empty measurement is insufficient_data', (await L.commit({ captureSessionId: 's1', roomId: 'r3' })).error, 'insufficient_data');

  return t.report();
};
