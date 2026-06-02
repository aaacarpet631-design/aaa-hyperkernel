/* Action safety gate — classify proposed actions by reversibility/blast radius. */
'use strict';
const { makeRunner } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('action-safety-gate');
  const G = global; G.window = G;
  delete require.cache[require.resolve('../../js/agents/action-safety-gate.js')];
  require('../../js/agents/action-safety-gate.js');
  const Gate = G.AAA_ACTION_GATE;

  t.ok('exposed', !!Gate && typeof Gate.assess === 'function');

  // --- allow: local / reversible / internal ---------------------------------
  t.eq('plain note -> allow', Gate.assess('Add a unit test for the parser').decision, 'allow');
  t.eq('read-only -> allow', Gate.assess({ command: 'git status' }).decision, 'allow');

  // --- needs_approval: destructive ------------------------------------------
  t.eq('rm -rf build -> needs_approval', Gate.assess({ command: 'rm -rf build' }).decision, 'needs_approval');
  t.eq('git push --force -> needs_approval', Gate.assess('git push --force origin main').decision, 'needs_approval');
  t.eq('git reset --hard -> needs_approval', Gate.assess('git reset --hard HEAD~3').decision, 'needs_approval');
  const delSql = Gate.assess({ command: 'DELETE FROM customers WHERE 1=1' });
  t.eq('DELETE FROM -> needs_approval', delSql.decision, 'needs_approval');
  t.ok('destructive category tagged', delSql.categories.indexOf('destructive') !== -1);
  t.eq('destructive level high', delSql.level, 'high');

  // --- needs_approval: external / spend -------------------------------------
  t.eq('email customer -> needs_approval', Gate.assess('Send an email to the customer with the quote').decision, 'needs_approval');
  const refund = Gate.assess('Issue a refund of $400 to the customer');
  t.eq('refund -> needs_approval', refund.decision, 'needs_approval');
  t.ok('spend category tagged', refund.categories.indexOf('spend') !== -1);

  // --- high-risk tool by name (args-agnostic) -------------------------------
  t.eq('tool send_slack -> needs_approval', Gate.assess({ tool: 'send_slack', text: 'hi' }).decision, 'needs_approval');
  t.eq('tool deploy_production -> needs_approval', Gate.assess({ tool: 'deploy_production' }).decision, 'needs_approval');

  // --- deny: catastrophic / never auto-run ----------------------------------
  t.eq('rm -rf / -> deny', Gate.assess({ command: 'rm -rf /' }).decision, 'deny');
  t.eq('drop database -> deny', Gate.assess('DROP DATABASE production').decision, 'deny');
  t.eq('deny level critical', Gate.assess({ command: 'rm -rf /' }).level, 'critical');

  // --- review(): summarize a list of next_actions ---------------------------
  const rev = Gate.review([
    'Write tests for the new module',          // allow
    'git push --force origin main',            // needs_approval
    'Send the customer an SMS reminder',       // needs_approval
    'DROP DATABASE prod'                       // deny
  ]);
  t.eq('review total', rev.total, 4);
  t.eq('review allowed', rev.allowed, 1);
  t.eq('review needsApproval', rev.needsApproval, 2);
  t.eq('review denied', rev.denied, 1);
  t.ok('review blocked flag', rev.blocked === true);

  const clean = Gate.review(['Add a test', 'Refactor the parser', 'Update the README']);
  t.ok('all-safe list not blocked', clean.blocked === false && clean.allowed === 3);

  // --- robustness -----------------------------------------------------------
  t.eq('null action -> allow (nothing to do)', Gate.assess(null).decision, 'allow');
  t.eq('empty review -> not blocked', Gate.review([]).blocked, false);

  return t.report();
};
