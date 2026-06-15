/* Telemetry Seal — cryptographic, tamper-evident proof of field execution.
 *
 * Guards the honest contract: a real SHA-256 binds the image; the seal lands in
 * the hash-chained audit ledger (and the chain still verifies after); altering
 * a byte breaks verifyImage; geolocation is recorded when given and honestly
 * null when not; and it refuses to seal (rather than fake a hash) without the
 * ledger. It proves CAPTURE INTEGRITY — never a quality verdict. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('telemetry-seal');
  const { G } = setupEnv();
  load('js/governance/audit-ledger.js');
  load('js/intelligence/telemetry-seal.js');
  const SEAL = G.AAA_TELEMETRY_SEAL, LED = G.AAA_AUDIT_LEDGER;

  // ===== seal: real SHA-256 into the chained ledger =====
  const img = 'data:image/jpeg;base64,QUJDREVGMTIzNHRoZV9waXhlbHM='; // stand-in image bytes
  const s1 = await SEAL.seal({ jobId: 'j1', imageBase64: img, visualMemoryId: 'vm1', imageRef: 'media_1', geo: { lat: 29.76, lng: -95.37, accuracy: 5 } });
  t.ok('seal returns ok with a hash + audit id', s1.ok === true && !!s1.seal.imageHash && !!s1.seal.auditId);
  t.eq('hash algorithm is honestly labeled SHA-256', s1.seal.alg, 'SHA-256');
  t.ok('hash is a 64-char hex SHA-256', /^[0-9a-f]{64}$/.test(s1.seal.imageHash));
  t.eq('the hash equals the ledger sha256 of the image', s1.seal.imageHash, LED.sha256(img));
  t.ok('geolocation is sealed when provided', s1.seal.geo && s1.seal.geo.lat === 29.76 && s1.seal.geo.lng === -95.37);

  // determinism + uniqueness
  const s1b = await SEAL.seal({ jobId: 'j1', imageBase64: img });
  t.eq('same image content → same hash (deterministic)', s1b.seal.imageHash, s1.seal.imageHash);
  const s2 = await SEAL.seal({ jobId: 'j2', imageBase64: img + 'X' });
  t.ok('a different image → a different hash', s2.seal.imageHash !== s1.seal.imageHash);

  // geo honest-null when absent
  const s3 = await SEAL.seal({ jobId: 'j3', imageBase64: img });
  t.ok('geo is null when not provided (never fabricated)', s3.seal.geo === null);

  // ===== the chained ledger still verifies after sealing (tamper-evident) =====
  const v = await LED.verify();
  t.ok('the audit chain is intact after sealing', v.ok === true);

  // ===== verifyImage: the mathematically-enforced tamper check =====
  t.ok('verifyImage matches the original bytes', SEAL.verifyImage(img, s1.seal.imageHash).match === true);
  t.ok('verifyImage detects any alteration', SEAL.verifyImage(img + 'tampered', s1.seal.imageHash).match === false);

  // ===== forJob: telemetry events for a job =====
  const j1seals = await SEAL.forJob('j1');
  t.ok('forJob returns the job\'s telemetry seals', j1seals.length === 2 && j1seals.every((e) => e.type === 'TelemetryCaptured'));

  // ===== honest refusals (no fabrication) =====
  t.eq('refuses without a job', (await SEAL.seal({ imageBase64: img })).error, 'NO_JOB');
  t.eq('refuses without image content or hash', (await SEAL.seal({ jobId: 'j9' })).error, 'NO_IMAGE');
  const savedLed = G.AAA_AUDIT_LEDGER; delete G.AAA_AUDIT_LEDGER;
  t.eq('refuses to seal without the audit ledger (no weak hash mislabeled SHA-256)', (await SEAL.seal({ jobId: 'j1', imageBase64: img })).error, 'NO_AUDIT_LEDGER');
  G.AAA_AUDIT_LEDGER = savedLed;

  // ===== currentGeo honest-null without geolocation =====
  t.ok('currentGeo is null when the platform has no geolocation', (await SEAL.currentGeo()) === null);

  return t.report();
};
