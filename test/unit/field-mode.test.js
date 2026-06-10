/* Field Mode OS — land on the money action. App Mode controller (field vs
 * executive, nav, landing) + Field Mode Home render model (greeting, START
 * MEASUREMENT primary, quick actions with honest availability, today's jobs
 * below, ask-HyperKernel) + start routing. DOM-free. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('field-mode');
  const { G, data, cfg } = setupEnv({ config: { businessName: 'AAA Carpet', ownerName: 'Aaron' } });
  load('js/ui/app-mode.js');
  load('js/ui/field-mode-home.js');
  const MODE = G.AAA_APP_MODE, HOME = G.AAA_FIELD_MODE_HOME;

  // ===== App Mode controller =====
  t.eq('default mode is field (the money action)', MODE.get(), 'field');
  t.eq('field landing tab is Measure', MODE.landingTab('field'), 'measure');
  t.eq('executive landing tab is Focus', MODE.landingTab('executive'), 'focus');
  const fieldNav = MODE.navItems('field').map((n) => n.tab);
  t.ok('field nav is Measure/Jobs/Chat/More (no AI Agents)', JSON.stringify(fieldNav) === JSON.stringify(['measure', 'jobs', 'chat', 'more']));
  const execNav = MODE.navItems('executive').map((n) => n.tab);
  t.ok('executive nav leads with Focus + has Business', execNav[0] === 'focus' && execNav.indexOf('business') !== -1);
  t.ok('toggle switches and persists the mode', MODE.toggle().mode === 'executive' && MODE.get() === 'executive' && cfg._all().appMode === 'executive');
  MODE.set('field');
  t.eq('an unknown mode is rejected', MODE.set('zen').error, 'UNKNOWN_MODE');

  // ===== Field Mode Home render model =====
  const NOON = Date.parse('2026-06-10T17:00:00Z'); // afternoon UTC
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Smith', currentState: 'IN_PROGRESS' });
  await data.put('jobs', 'j2', { id: 'j2', customerName: 'Jones', currentState: 'SCHEDULED' });
  await data.put('jobs', 'j3', { id: 'j3', customerName: 'Old', currentState: 'CLOSED' });

  const m = await HOME.renderModel({ now: NOON });
  t.ok('greeting is time-aware and personal', /Good afternoon, Aaron/.test(m.greeting));
  t.eq('the primary action is START MEASUREMENT', m.primaryAction.label, 'START MEASUREMENT');
  t.ok('four quick actions are offered', m.quickActions.length === 4 && m.quickActions.map((q) => q.id).indexOf('scan_room') !== -1 && m.quickActions.map((q) => q.id).indexOf('voice_note') !== -1);
  t.ok('quick actions are honestly unavailable when no engine is loaded', m.quickActions.every((q) => q.available === false));
  t.ok("today's jobs show active work only (closed excluded)", m.todaysJobs.length === 2 && m.todaysJobs.every((j) => j.id !== 'j3'));
  t.ok('ask-HyperKernel prompt is present', /focus/i.test(m.ask.placeholder));

  // ===== availability flips when an engine exists =====
  G.AAA_VOICE_HUD_UI = { boot: function () {} };
  const m2 = await HOME.renderModel({ now: NOON });
  t.ok('voice note becomes available once the voice HUD is loaded', m2.quickActions.find((q) => q.id === 'voice_note').available === true);
  delete G.AAA_VOICE_HUD_UI;

  // ===== start routing (honest: no DOM / no engine → not routed, no throw) =====
  const started = HOME.start({});
  t.ok('start measurement reports honestly when no engine/DOM is present', started.ok === false || started.routed === false);
  const q = HOME.startQuick('scan_room', {});
  t.ok('an unavailable quick action does not pretend to run', q.ok === false && q.reason === 'unavailable');
  t.eq('an unknown quick action is rejected', HOME.startQuick('teleport', {}).reason, 'UNKNOWN_ACTION');

  // ===== greeting boundaries =====
  t.ok('morning greeting before noon', /Good morning/.test((await HOME.renderModel({ now: Date.parse('2026-06-10T08:00:00Z') })).greeting));

  return t.report();
};
