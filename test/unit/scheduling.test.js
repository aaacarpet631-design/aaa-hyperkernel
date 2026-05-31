/* Scheduling — conflict detection (crew + time overlap), buckets, wouldConflict. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('scheduling');
  const { G, data } = setupEnv({ fixedISO: '2026-06-01T08:00:00Z' });
  load('js/scheduling/schedule-store.js');
  const S = G.AAA_SCHEDULING;

  data._store.jobs = {
    j1: { id: 'j1', customerName: 'A', currentState: 'SCHEDULED', scheduledDate: '2026-06-02T09:00:00', durationMins: 120, assigneeIds: ['joe'] },
    j2: { id: 'j2', customerName: 'B', currentState: 'SCHEDULED', scheduledDate: '2026-06-02T10:00:00', durationMins: 60, assigneeIds: ['joe'] },
    j3: { id: 'j3', customerName: 'C', currentState: 'SCHEDULED', scheduledDate: '2026-06-02T14:00:00', durationMins: 60, assigneeIds: ['joe'] },
    j4: { id: 'j4', customerName: 'D', currentState: 'QUOTE_OPEN' }
  };
  t.eq('1 conflict (j1/j2 overlap+crew)', (await S.conflictsForDay('2026-06-02')).length, 1);
  t.ok('j3 not conflicting', !(await S.conflictsForDay('2026-06-02')).some((c) => c.a.id === 'j3' || c.b.id === 'j3'));

  data._store.jobs.j2.assigneeIds = ['bob'];
  t.eq('no conflict when crew differs', (await S.conflictsForDay('2026-06-02')).length, 0);

  const cal = await S.calendar();
  t.ok('unscheduled bucket has j4', cal.unscheduled.some((j) => j.id === 'j4'));
  t.ok('day sorted, j1 first', cal.days['2026-06-02'][0].id === 'j1');

  data._store.jobs.j2.assigneeIds = ['joe'];
  t.ok('wouldConflict overlap true', (await S.wouldConflict({ id: 'n', scheduledDate: '2026-06-02T09:30:00', durationMins: 60 }, ['joe'])).conflict === true);
  t.ok('wouldConflict 8pm false', (await S.wouldConflict({ id: 'n', scheduledDate: '2026-06-02T20:00:00', durationMins: 60 }, ['joe'])).conflict === false);
  t.eq('upcoming starts today', (await S.upcoming(3))[0].date, '2026-06-01');

  return t.report();
};
