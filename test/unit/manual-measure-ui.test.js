/* Manual Measure — the tape-measure path onto the Field Mode start screen.
 *
 * Guards: buildRoom() validates honestly (both dims or linear feet or stairs;
 * bad numbers name the field); saveRoom() persists through the SAME field
 * capture session spine the laser uses (source 'manual', lazy session
 * creation, Field Brain totals aggregate); missing capture module and missing
 * DOM degrade honestly. DOM-free. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('manual-measure-ui');
  const { G } = setupEnv();
  ['js/measurements/models/measurement-models.js', 'js/measurements/storage/measurement-store.js',
   'js/quotes/integrations/measurement-to-quote.js', 'js/measurements/field-brain.js',
   'js/measurements/field-capture-session.js', 'js/ui/manual-measure-ui.js'].forEach(load);
  const MM = G.AAA_MANUAL_MEASURE_UI, FCS = G.AAA_FIELD_CAPTURE_SESSION;

  // ===== buildRoom(): pure validation =====
  const ok = MM.buildRoom({ roomName: '  Living room ', length: '12', width: 10.5, stairsCount: '' });
  t.ok('length×width room builds with source manual', ok.ok && ok.room.length === 12 && ok.room.width === 10.5 && ok.room.source === 'manual');
  t.eq('room name is trimmed', ok.room.roomName, 'Living room');
  t.ok('linear-feet-only room is valid (stairs/hallway runs)', MM.buildRoom({ linearFeet: 14 }).ok === true);
  t.ok('stairs-only room is valid', MM.buildRoom({ stairsCount: 12 }).ok && MM.buildRoom({ stairsCount: 12 }).room.stairsCount === 12);
  t.eq('empty form is refused', MM.buildRoom({}).error, 'NO_DIMENSIONS');
  t.eq('length without width is refused', MM.buildRoom({ length: 12 }).error, 'NEED_BOTH_DIMENSIONS');
  const bad = MM.buildRoom({ length: -3, width: 'abc' });
  t.ok('bad numbers name the offending fields', bad.error === 'INVALID_DIMENSION' && bad.fields.indexOf('length') !== -1 && bad.fields.indexOf('width') !== -1);
  t.eq('fractional stairs are refused', MM.buildRoom({ length: 10, width: 10, stairsCount: 2.5 }).error, 'INVALID_DIMENSION');

  // ===== saveRoom(): persists through the capture-session spine =====
  const first = await MM.saveRoom(null, { roomName: 'Living', length: 12, width: 10 });
  t.ok('first save lazily starts a capture session', first.ok === true && !!first.sessionId && first.room.id);
  const second = await MM.saveRoom(first.sessionId, { roomName: 'Hall', linearFeet: 14, stairsCount: 12 });
  t.ok('second room lands in the SAME session', second.ok && second.sessionId === first.sessionId && second.session.roomIds.length === 2);
  const rooms = await FCS.rooms(first.sessionId);
  t.ok('rooms persist with source manual', rooms.length === 2 && rooms.every((r) => r.source === 'manual'));

  // downstream Field Brain math works identically to laser capture
  const sum = await FCS.summarize(first.sessionId);
  t.ok('Field Brain aggregates manual rooms (120 ft² + stairs)', sum.status === 'derived' && sum.totalSquareFeet >= 120 && sum.totalStairs === 12);
  const draft = await FCS.buildQuoteDraft(first.sessionId, {});
  t.ok('a quote draft builds from manual rooms and needs review', draft.status === 'drafted' && draft.needsReview === true);

  // invalid input never creates a session
  const before = (await FCS.list()).length;
  const rejected = await MM.saveRoom(null, { length: 5 });
  t.ok('invalid input is refused BEFORE any session is created', rejected.ok === false && (await FCS.list()).length === before);

  // ===== honest degradation =====
  const savedFCS = G.AAA_FIELD_CAPTURE_SESSION; delete G.AAA_FIELD_CAPTURE_SESSION;
  t.eq('missing capture module is an honest error', (await MM.saveRoom(null, { length: 10, width: 10 })).error, 'CAPTURE_UNAVAILABLE');
  G.AAA_FIELD_CAPTURE_SESSION = savedFCS;
  const opened = MM.open({});
  t.ok('open() without a DOM reports honestly', opened.opened === false && opened.reason === 'no_dom');
  t.ok('summary() tolerates a missing session id', (await MM.summary(null)) === null);

  return t.report();
};
