/* RBAC permission matrix — crew/manager/owner grants + fail-closed. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('rbac');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  const R = G.AAA_RBAC;

  t.eq('default role owner', R.role(), 'owner');
  t.ok('owner sees financials', R.can('VIEW_FINANCIALS'));
  t.ok('owner sees margins', R.can('VIEW_MARGINS'));

  R.setRole('crew');
  t.eq('role now crew', R.role(), 'crew');
  t.ok('crew CANNOT see financials', R.can('VIEW_FINANCIALS') === false);
  t.ok('crew CANNOT see margins', R.can('VIEW_MARGINS') === false);
  t.ok('crew CANNOT approve quote', R.can('APPROVE_QUOTE') === false);
  t.ok('crew CANNOT close job', R.can('CLOSE_JOB') === false);
  t.ok('crew CAN capture measurement', R.can('CAPTURE_MEASUREMENT'));
  t.ok('crew CAN complete checklist', R.can('COMPLETE_CHECKLIST'));

  R.setRole('manager');
  t.ok('manager CANNOT see financials', R.can('VIEW_FINANCIALS') === false);
  t.ok('manager CAN approve quote', R.can('APPROVE_QUOTE'));
  t.ok('manager CAN manage crew', R.can('MANAGE_CREW'));
  t.ok('manager CANNOT manage settings', R.can('MANAGE_SETTINGS') === false);

  t.ok('unknown permission denied', R.can('NONSENSE') === false);
  t.ok('unknown role rejected', R.setRole('hacker').ok === false);

  return t.report();
};
