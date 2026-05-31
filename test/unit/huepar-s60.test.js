/*
 * Huepar S60-family BLE adapter — parser golden fixtures + registry wiring.
 *
 * The frame layouts are reverse-engineered (experimental/huepar-s60-v1), so
 * these fixtures lock in the DECODE we ship today: any change to byte order,
 * scaling, unit mapping, plausibility window or confidence will trip a test.
 * Fixtures are self-consistent (constructed from the documented layout), not
 * captures from a certified device — replace with real captures after lab
 * validation and the goldens here become regression anchors.
 */
'use strict';
const { makeRunner } = require('../helpers/harness');

function hexToDataView(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const b = new Uint8Array(clean.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(clean.substr(i * 2, 2), 16);
  return new DataView(b.buffer);
}

module.exports = function run() {
  const t = makeRunner('huepar-s60');
  const G = global; G.window = G;

  // Load base + registry + huepar (order matters: huepar self-registers).
  ['js/bluetooth/services/generic-ble-adapter.js',
   'js/bluetooth/services/device-adapter-registry.js',
   'js/bluetooth/services/huepar-s60-adapter.js'].forEach((rel) => {
    delete require.cache[require.resolve('../../' + rel)];
    require('../../' + rel);
  });
  const P = G.AAA_HUEPAR_S60_PARSER;
  const Reg = G.AAA_DEVICE_ADAPTER_REGISTRY;

  t.ok('parser exposed', !!P && P.version === 'experimental/huepar-s60-v1');

  // --- distance: 2.5 m, display unit metres (unitMode 1) --------------------
  // f1 04 01 00 07 |01| 01 31 50 |03 d0 90| 00 |aa
  const d25 = P.parseFrame('f1040100070101315003d09000aa');
  t.ok('2.5m kind', d25 && d25.kind === 'distance');
  t.eq('2.5m meters', d25.meters, 2.5);
  t.eq('2.5m feet', d25.feet, 8.202);
  t.eq('2.5m display unit', d25.displayedUnit, 'm');
  t.ok('2.5m plausible', d25.plausible === true);

  const r25 = P.parse('f1040100070101315003d09000aa');
  t.ok('2.5m reading emitted', !!r25 && r25.feet === 8.202 && r25.unit === 'm');
  t.eq('2.5m confidence (no quality flag)', r25.confidence, 0.9);
  t.eq('2.5m via', r25.via, 'huepar-frame');

  // --- distance via a real DataView (what Web Bluetooth hands the adapter) ---
  const rDv = P.parse(hexToDataView('f1040100070101315003d09000aa'));
  t.ok('parses DataView like a notify frame', !!rDv && rDv.feet === 8.202);

  // --- distance: 3.0 m but meter shown in FEET display mode (unitMode 2) -----
  // canonical meters must be independent of the meter's display unit.
  const dFt = P.parse('f104010007020131500493e000bb');
  t.ok('3.0m feet-display still canonical', !!dFt && dFt.meters === 3 && dFt.feet === 9.843);
  t.eq('3.0m display unit reported', dFt.displayedUnit, 'ft');

  // --- quality flag set -> lower confidence (lands in review, not the total) -
  const dQ = P.parse('f1040100070101315003d09001aa');
  t.eq('quality flag lowers confidence', dQ.confidence, 0.8);

  // --- implausible decode (167.77 m) is rejected, not guessed ---------------
  const dBad = P.parseFrame('f10401000701013150ffffff00aa');
  t.ok('implausible flagged', dBad && dBad.plausible === false);
  t.ok('implausible NOT emitted as reading', P.parse('f10401000701013150ffffff00aa') === null);

  // --- angle/tilt frame decoded for diagnostics, NOT emitted as a length ----
  // X=+12.5 (0x107d), Y=-3.0 (0x001e), Z=0 (0x0000)
  const ang = P.parseFrame('f102010004107d001e0000aa');
  t.ok('angle kind', ang && ang.kind === 'angles');
  t.eq('angle X', ang.xDeg, 12.5);
  t.eq('angle Y', ang.yDeg, -3);
  t.eq('angle Z', ang.zDeg, 0);
  t.ok('angle frame is not a measurement', P.parse('f102010004107d001e0000aa') === null);

  // --- unknown / non-Huepar frame -> null (adapter falls back to generic) ---
  t.ok('non-f1 frame -> null', P.parseFrame('1234567890') === null);
  t.ok('too-short frame -> null', P.parseFrame('f104') === null);

  // --- error frame surfaced for diagnostics ---------------------------------
  const err = P.parseFrame('f10501151b');
  t.ok('error frame surfaced', err && err.kind === 'error');
  t.ok('error frame not a reading', P.parse('f10501151b') === null);

  // --- device fingerprinting (name pattern OR service shape) -----------------
  t.ok('matches LDM-S60-BT by name', G.AAA_HUEPAR_S60_ADAPTER.match({ name: 'LDM-S60-BT' }));
  t.ok('matches by Huepar name', G.AAA_HUEPAR_S60_ADAPTER.match({ name: 'Huepar Laser' }));
  t.ok('matches by service shape', G.AAA_HUEPAR_S60_ADAPTER.match({ services: [P.SERVICE] }));
  t.ok('does not match unrelated brand', !G.AAA_HUEPAR_S60_ADAPTER.match({ name: 'Bosch GLM 50' }));

  // --- registry prefers the Huepar adapter, generic stays the fallback ------
  const picked = Reg.resolve({ name: 'LDM-S60-BT' });
  t.eq('registry picks huepar for Huepar device', picked && picked.id, 'huepar-s60');
  const fallback = Reg.resolve({ name: 'Some Random Laser' });
  t.eq('registry falls back to generic otherwise', fallback && fallback.id, 'generic-ble');

  // --- adapter instance shape -----------------------------------------------
  const inst = G.AAA_HUEPAR_S60_ADAPTER.create();
  t.ok('adapter has measure()', inst && typeof inst.measure === 'function');
  t.ok('adapter has clearLast()', inst && typeof inst.clearLast === 'function');
  t.ok('adapter id is huepar-s60', inst && inst.id === 'huepar-s60');

  return t.report();
};
