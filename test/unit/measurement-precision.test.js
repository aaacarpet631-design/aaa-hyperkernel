/* Measurement Precision Engine — type what the tape says.
 *
 * Guards: tape notation (12'6", 12 ft 6 in, 150", 3.8m, 380cm, plain feet)
 * parses to exact decimal feet; garbage is refused with UNPARSEABLE, blanks
 * with EMPTY; formatFeet round-trips to tape display; multi-section rooms
 * (L-shapes, cut-outs) sum honestly and can never go negative; check()
 * delegates to the models' single source of validation truth. Pure + DOM-free. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('measurement-precision');
  const { G } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/measurements/precision-engine.js');
  const P = G.AAA_MEASUREMENT_PRECISION;

  // ===== parseLength: the notation matrix =====
  t.eq("12'6\" parses to 12.5 ft", P.parseLength('12\'6"').feet, 12.5);
  t.eq("12' 6\" (spaced) parses the same", P.parseLength("12' 6\"").feet, 12.5);
  t.eq('12ft 6in parses to 12.5', P.parseLength('12ft 6in').feet, 12.5);
  t.eq('12 feet 6 inches parses to 12.5', P.parseLength('12 feet 6 inches').feet, 12.5);
  t.eq("bare feet 12' parses to 12", P.parseLength("12'").feet, 12);
  t.eq('inches-only 150" parses to 12.5 ft', P.parseLength('150"').feet, 12.5);
  t.eq('150 in parses to 12.5 ft', P.parseLength('150 in').feet, 12.5);
  t.eq('plain decimal 12.5 parses as feet', P.parseLength('12.5').feet, 12.5);
  t.eq('a raw number is accepted as feet', P.parseLength(12.5).feet, 12.5);
  t.eq('3.8m converts (12.467 ft)', P.parseLength('3.8m').feet, 12.467);
  t.eq('380cm converts (12.467 ft)', P.parseLength('380cm').feet, 12.467);
  t.ok('unicode prime marks parse (12′ 6″)', P.parseLength('12′ 6″').feet === 12.5);
  t.eq('empty input is an omission, not an error', P.parseLength('').error, 'EMPTY');
  t.eq('null input is EMPTY', P.parseLength(null).error, 'EMPTY');
  t.eq('garbage is UNPARSEABLE', P.parseLength('about twelve').error, 'UNPARSEABLE');
  t.eq("12'14\" (impossible inches) is refused", P.parseLength('12\'14"').error, 'UNPARSEABLE');
  t.eq('negative-ish garbage is refused', P.parseLength('-12').error, 'UNPARSEABLE');

  // ===== formatFeet: back to tape display =====
  t.eq('12.5 formats as 12′ 6″', P.formatFeet(12.5), '12′ 6″');
  t.eq('whole feet drop the inches', P.formatFeet(12), '12′');
  t.eq('11.99 rounds to the nearest inch → 12′', P.formatFeet(11.99), '12′');
  t.ok('junk formats to null', P.formatFeet('x') === null && P.formatFeet(-1) === null);

  // ===== parseCount (stairs) =====
  t.ok('blank stairs is null (omission)', P.parseCount('').ok && P.parseCount('').count === null);
  t.eq('13 stairs parse', P.parseCount('13').count, 13);
  t.ok('fractional or negative stairs are refused', !P.parseCount('2.5').ok && !P.parseCount('-3').ok);

  // ===== roomArea: L-shapes and cut-outs =====
  const L = P.roomArea([
    { label: 'main', length: "12'", width: "10'" },
    { label: 'alcove', length: "6'", width: "4'" }
  ]);
  t.ok('L-shaped room sums sections (120 + 24)', L.ok && L.squareFeet === 144 && L.sections.length === 2);
  const cut = P.roomArea([
    { length: 12, width: 10 },
    { label: 'hearth', length: 4, width: 2, op: 'subtract' }
  ]);
  t.eq('a cut-out subtracts (120 − 8)', cut.squareFeet, 112);
  t.ok('sections accept tape notation', P.roomArea([{ length: "12'6\"", width: '10' }]).squareFeet === 125);
  const neg = P.roomArea([{ length: 5, width: 5 }, { length: 10, width: 10, op: 'subtract' }]);
  t.eq('subtracting below zero is refused', neg.error, 'NEGATIVE_AREA');
  const badSec = P.roomArea([{ length: 12, width: 10 }, { length: 'huh', width: 4 }]);
  t.ok('an unparseable section names its index', badSec.error === 'UNPARSEABLE_SECTION' && badSec.index === 1);
  t.eq('no sections is refused', P.roomArea([]).error, 'NO_SECTIONS');

  // ===== check(): one source of validation truth =====
  const warn = P.check({ roomName: 'Big', length: 250, width: 10 });
  t.ok('delegates to the models (250 ft length warning)', warn.warnings.some((w) => /200 ft/.test(w)));
  const dup = P.check({ roomName: 'Living', length: 12, width: 10, squareFeet: 120 },
    { existing: [{ id: 'other', roomName: 'living', length: 12, width: 10, squareFeet: 120 }] });
  t.ok('duplicate detection flows through', dup.warnings.some((w) => /duplicate/i.test(w)));
  const savedModels = G.AAA_MEASUREMENT_MODELS; delete G.AAA_MEASUREMENT_MODELS;
  const fb = P.check({ length: 300, width: 10 });
  G.AAA_MEASUREMENT_MODELS = savedModels;
  t.ok('minimal fallback still warns when models are absent', fb.ok && fb.warnings.length > 0);

  return t.report();
};
