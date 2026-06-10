/*
 * Golden Eval Store — deterministic graders + case lifecycle + run/compare.
 * Pure measurement; no network, no LLM judge.
 */
'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');
const seed = require(path.join(ROOT, 'data/eval-golden.seed.json'));

module.exports = async function run() {
  const t = makeRunner('eval-golden');
  const { G } = setupEnv({});
  load('js/intelligence/eval-golden-store.js');
  const EV = G.AAA_EVAL_GOLDEN;

  // ---- deterministic graders (pure) --------------------------------------
  const mapeCase = { caseId: 'm', taskType: 'estimate', grader: 'numeric_mape', referenceValue: 1000, graderConfig: { tolerance: 0.15 } };
  t.ok('mape exact → score 1, pass', EV.gradeNumericMape(1000, mapeCase).score === 1 && EV.gradeNumericMape(1000, mapeCase).pass);
  t.ok('mape within tolerance passes', EV.gradeNumericMape(1100, mapeCase).pass === true && EV.gradeNumericMape(1100, mapeCase).mape === 0.1);
  t.ok('mape outside tolerance fails', EV.gradeNumericMape(1300, mapeCase).pass === false);
  t.ok('mape parses "$1,100" string', EV.gradeNumericMape('$1,100', mapeCase).mape === 0.1);
  t.eq('mape non-numeric → error', EV.gradeNumericMape('n/a', mapeCase).error, 'NON_NUMERIC');

  const safeCase = { grader: 'safety_label', reference: { expected: 'unsafe' } };
  t.ok('safety match → pass', EV.gradeSafety({ label: 'unsafe' }, safeCase).pass === true);
  t.ok('safety mismatch → fail', EV.gradeSafety({ label: 'safe' }, safeCase).pass === false);
  t.ok('safety accepts bare string', EV.gradeSafety('unsafe', safeCase).pass === true);

  const cont = { grader: 'contains', graderConfig: { mustInclude: ['review'], mustNotInclude: ['guarantee'] } };
  t.ok('contains: include present, exclude absent → pass', EV.gradeContains('Please leave a Review!', cont).pass === true);
  t.ok('contains: missing required → fail', EV.gradeContains('Thanks!', cont).pass === false && EV.gradeContains('Thanks!', cont).missing[0] === 'review');
  t.ok('contains: banned present → fail', EV.gradeContains('review + lifetime guarantee', cont).pass === false);

  t.ok('exact match', EV.gradeExact('Yes', { grader: 'exact', reference: { output: 'yes' } }).pass === true);

  const js = { grader: 'json_schema', graderConfig: { schema: { required: ['recommendation', 'confidence'], properties: { confidence: { type: 'number' } } } } };
  t.ok('json_schema valid', EV.gradeJsonSchema({ recommendation: 'go', confidence: 0.8 }, js).pass === true);
  t.ok('json_schema missing key', EV.gradeJsonSchema({ recommendation: 'go' }, js).missing[0] === 'confidence');
  t.ok('json_schema wrong type', EV.gradeJsonSchema({ recommendation: 'go', confidence: 'high' }, js).typeErrors[0] === 'confidence');
  t.eq('json_schema non-object', EV.gradeJsonSchema('nope', js).error, 'NOT_OBJECT');

  // ---- score dispatch -----------------------------------------------------
  t.eq('unknown grader rejected', EV.score('x', { grader: 'magic' }).error, 'UNKNOWN_GRADER');

  // ---- case lifecycle + gates --------------------------------------------
  t.eq('unknown task type rejected', (await EV.addCase({ taskType: 'cooking', grader: 'exact' })).error, 'UNKNOWN_TASK_TYPE');
  t.eq('unknown grader on add rejected', (await EV.addCase({ taskType: 'estimate', grader: 'vibe' })).error, 'UNKNOWN_GRADER');
  const added = await EV.addCase({ taskType: 'estimate', grader: 'numeric_mape', referenceValue: 1000, piiCleared: false });
  t.ok('case starts draft', added.ok && added.case.status === 'draft');
  t.eq('cannot activate without piiCleared', (await EV.setStatus(added.case.caseId, 'active')).error, 'PII_NOT_CLEARED');
  await EV.addCase({ caseId: added.case.caseId, taskType: 'estimate', grader: 'numeric_mape', referenceValue: 1000, piiCleared: true }); // re-author cleared
  t.ok('activates once piiCleared', (await EV.setStatus(added.case.caseId, 'active')).ok === true);
  t.eq('bad status rejected', (await EV.setStatus(added.case.caseId, 'live')).error, 'BAD_STATUS');

  // ---- import seed templates ---------------------------------------------
  const imp = await EV.importCases(seed.cases);
  t.ok('seed templates imported', imp.ok && imp.imported === seed.cases.length);
  t.eq('active templates listed', (await EV.listCases({ taskType: 'message_safety', status: 'active' })).length, 2);

  // ---- run() aggregation + safety precision/recall ------------------------
  const safetyRun = await EV.run('message_safety', [
    { caseId: 'ev_tmpl_safety_unsafe', output: { label: 'unsafe' } },  // correct
    { caseId: 'ev_tmpl_safety_safe', output: { label: 'unsafe' } }     // false block
  ]);
  t.ok('run aggregates n + passRate', safetyRun.n === 2 && safetyRun.passRate === 0.5);
  t.ok('safety precision/recall derived', safetyRun.safety.recall === 1 && safetyRun.safety.falseBlockRate === 1);

  // ---- compareVersions detects regression --------------------------------
  const baseline = await EV.run('message_safety', [
    { caseId: 'ev_tmpl_safety_unsafe', output: { label: 'unsafe' } },
    { caseId: 'ev_tmpl_safety_safe', output: { label: 'safe' } }
  ]);
  const candidate = await EV.run('message_safety', [
    { caseId: 'ev_tmpl_safety_unsafe', output: { label: 'unsafe' } },
    { caseId: 'ev_tmpl_safety_safe', output: { label: 'unsafe' } } // regressed
  ]);
  const cmp = EV.compareVersions(baseline, candidate);
  t.ok('regression detected', cmp.hasRegression === true && cmp.regressed.indexOf('ev_tmpl_safety_safe') !== -1);
  t.ok('no false regression on stable case', cmp.regressed.indexOf('ev_tmpl_safety_unsafe') === -1);

  // ---- owner gate ---------------------------------------------------------
  load('js/core/aaa-rbac.js');
  G.AAA_CONFIG.set({ role: 'crew' });
  t.eq('non-owner cannot author cases', (await EV.addCase({ taskType: 'estimate', grader: 'exact' })).error, 'FORBIDDEN');
  G.AAA_CONFIG.set({ role: 'owner' });
  t.ok('owner can author', (await EV.addCase({ taskType: 'estimate', grader: 'exact' })).ok === true);

  return t.report();
};
