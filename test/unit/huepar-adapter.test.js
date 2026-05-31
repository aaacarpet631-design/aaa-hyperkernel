/* Huepar S60-G-BT adapter — registry routing, parse, de-dupe, debug, no-fabricate. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function dvText(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new DataView(b.buffer); }
function dvBytes(arr) { return new DataView(new Uint8Array(arr).buffer); }

module.exports = function run() {
  const t = makeRunner('huepar-adapter');
  const { G } = setupEnv();
  load('js/bluetooth/services/raw-reading-log.js');
  load('js/bluetooth/services/measurement-parser.js');
  load('js/bluetooth/services/generic-ble-adapter.js');
  load('js/bluetooth/services/device-adapter-registry.js');
  load('js/bluetooth/services/huepar-s60-g-bt-adapter.js');

  const Reg = G.AAA_DEVICE_ADAPTER_REGISTRY;
  const Huepar = G.AAA_HUEPAR_S60_ADAPTER;
  const Generic = G.AAA_GENERIC_BLE_ADAPTER;

  // generic adapter must remain intact + only additively extended
  t.ok('generic adapter still exported', typeof Generic === 'function');
  t.ok('generic keeps battery optional service', Generic.optionalServices().indexOf('battery_service') !== -1);
  t.ok('huepar registered NUS into generic optionalServices', Generic.optionalServices().indexOf(Huepar.NUS_SERVICE) !== -1);

  // registry routing
  t.eq('resolve "Huepar S60-G-BT"', Reg.resolve({ name: 'Huepar S60-G-BT' }).id, 'huepar-s60-g-bt');
  t.eq('resolve "S60"', Reg.resolve({ name: 'S60' }).id, 'huepar-s60-g-bt');
  t.eq('resolve by NUS service', Reg.resolve({ name: 'Unknown', services: [Huepar.NUS_SERVICE] }).id, 'huepar-s60-g-bt');
  t.eq('random name -> generic fallback', Reg.resolve({ name: 'Random Speaker' }).id, 'generic-ble');
  t.ok('matchesName positive', Huepar.matchesName('huepar laser') === true);
  t.ok('matchesName empty false', Huepar.matchesName('') === false);

  // parse: ASCII with explicit unit
  const a = new Huepar();
  let r = a.parse(dvText('1.234 m'));
  t.ok('parse "1.234 m" ~4.049 ft', r && Math.abs(r.feet - 4.049) < 0.01);
  t.eq('unit source device-text', r && r.unitSource, 'device-text');
  t.eq('via ascii', r && r.via, 'ascii');
  t.ok('confidence present', r && r.confidence > 0);
  t.ok('parse "10ft 6in" = 10.5', (function () { const x = a.parse(dvText('10ft 6in')); return x && Math.abs(x.feet - 10.5) < 0.001; })());

  // no guessing: bare number without a unit must not parse
  t.ok('bare "5.5" (no unit) -> null', new Huepar().parse(dvText('5.5')) === null);

  // binary fallback
  const ab = new Huepar();
  r = ab.parse(dvBytes([0xD2, 0x04])); // 1234 mm LE
  t.ok('binary 1234mm ~4.049 ft', r && Math.abs(r.feet - 4.049) < 0.02);
  t.eq('binary unit source inferred-binary', r && r.unitSource, 'inferred-binary');
  t.ok('binary confidence capped <=0.6', r && r.confidence <= 0.6);

  // de-dupe + emit through _onValue
  const a4 = new Huepar();
  a4._device = { id: 'dev1', name: 'Huepar S60-G-BT' };
  const emitted = [];
  a4.onReading((x) => emitted.push(x));
  const frame = (s) => ({ value: dvText(s), uuid: Huepar.NUS_TX_NOTIFY });
  a4._onValue(Huepar.NUS_SERVICE, frame('2.000 m'));
  a4._onValue(Huepar.NUS_SERVICE, frame('2.000 m')); // dup within window
  a4._onValue(Huepar.NUS_SERVICE, frame('3.500 m'));
  t.eq('de-dupe: 2 distinct from 3 frames', emitted.length, 2);
  t.eq('debug ring captured 3 frames', a4.debugFrames(10).length, 3);
  const d0 = a4.debugFrames(10)[0];
  t.ok('debug frame has hex', !!d0.hex && /[0-9a-f]/.test(d0.hex));
  t.ok('debug frame has ascii', d0.ascii.indexOf('3.500') !== -1);
  t.ok('debug frame has feet + confidence', d0.feet != null && d0.confidence > 0);

  // unknown frame: logged to debug, never emitted, never fabricated, never throws
  const a5 = new Huepar();
  a5._device = { id: 'd', name: 'Huepar' };
  const em2 = []; a5.onReading((x) => em2.push(x));
  a5._onValue('svc', { value: dvBytes([0, 0, 0, 0, 0, 0, 0, 0x99]), uuid: 'c' });
  t.eq('unparseable: nothing emitted', em2.length, 0);
  t.eq('unparseable: captured in debug', a5.debugFrames(5).length, 1);
  t.ok('unparseable debug feet=null (no fabrication)', a5.debugFrames(5)[0].feet === null);

  // prototype chain
  t.ok('inherits isSupported', typeof a.isSupported === 'function');
  t.ok('inherits disconnect', typeof a.disconnect === 'function');
  t.ok('id + label set', a.id === 'huepar-s60-g-bt' && /Huepar/.test(a.label));

  return t.report();
};
