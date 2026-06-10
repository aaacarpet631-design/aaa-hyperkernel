/*
 * AAA_EVAL_GOLDEN — deterministic eval harness unit tests.
 *
 * Covers case storage + validation (incl. the piiCleared gate and archive
 * exclusion), every grader (numeric_mape / safety_label / json_schema /
 * contains / exact) on pass and fail paths and unsafe inputs, the run()
 * aggregator, compareVersions() regression detection + promotion blocking, and
 * ingestion of the synthetic seed file. Pure, deterministic, no network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('eval-golden');
  const { G } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });
  load('js/intelligence/eval-golden-store.js');
  const EV = G.AAA_EVAL_GOLDEN;
  t.ok('global exists', !!EV);
  EV._clear();

  // ---- case creation + validation ------------------------------------------
  const created = EV.createCase({
    taskType: 'estimate_accuracy', title: 'T', grader: 'numeric_mape',
    referenceOutput: { referenceValue: 480, tolerancePct: 12 }, piiCleared: true
  });
  t.eq('case creation works', created.ok, true);
  t.ok('created case has id', !!created.case.id);

  const invalid = EV.createCase({ title: 'no grader/taskType' });
  t.eq('invalid case fails validation', invalid.ok, false);
  t.ok('validation lists missing fields', invalid.errors && invalid.errors.length > 0);

  // ---- piiCleared gate ------------------------------------------------------
  const gated = EV.createCase({
    taskType: 'estimate_accuracy', title: 'gated', grader: 'exact',
    referenceOutput: { value: 'x' }, status: 'active', piiCleared: false
  });
  t.eq('cannot become active without piiCleared', gated.ok, false);
  t.eq('gate error is PII_NOT_CLEARED', gated.error, 'PII_NOT_CLEARED');
  const okActive = EV.createCase({
    taskType: 'estimate_accuracy', title: 'cleared', grader: 'exact',
    referenceOutput: { value: 'x' }, status: 'active', piiCleared: true
  });
  t.eq('active allowed once piiCleared', okActive.ok, true);
  // update path also enforces the gate
  const draft = EV.createCase({ taskType: 'x', title: 'd', grader: 'exact', referenceOutput: { value: 'y' } });
  const promote = EV.updateCase(draft.case.id, { status: 'active' });
  t.eq('update gate blocks active without pii', promote.ok, false);

  // ---- archive exclusion ----------------------------------------------------
  EV.archiveCase(okActive.case.id);
  const visible = EV.listCases();
  t.ok('archived excluded by default', visible.every((c) => c.id !== okActive.case.id));
  t.ok('archived visible with includeArchived', EV.listCases({ includeArchived: true }).some((c) => c.id === okActive.case.id));

  // ---- grader: numeric_mape -------------------------------------------------
  const mapeCase = { id: 'm', grader: 'numeric_mape', taskType: 'estimate_accuracy', referenceOutput: { referenceValue: 480, tolerancePct: 12 } };
  t.eq('numeric_mape pass within tolerance', EV.score(505, mapeCase).pass, true);
  t.eq('numeric_mape fail beyond tolerance', EV.score(700, mapeCase).pass, false);
  t.ok('numeric_mape lower-is-better score', EV.score(505, mapeCase).score > EV.score(700, mapeCase).score);
  // zero / missing safety
  t.eq('numeric_mape missing candidate is safe (no throw)', EV.score(undefined, mapeCase).pass, false);
  t.ok('numeric_mape missing → INVALID detail', /INVALID/.test(EV.score(undefined, mapeCase).detail));
  const zeroCase = { id: 'z', grader: 'numeric_mape', taskType: 'x', referenceOutput: { referenceValue: 0, tolerancePct: 10 } };
  t.eq('numeric_mape zero ref, zero cand → pass', EV.score(0, zeroCase).pass, true);
  t.eq('numeric_mape zero ref, nonzero cand → fail (no divide error)', EV.score(5, zeroCase).pass, false);

  // ---- grader: safety_label -------------------------------------------------
  const unsafeCase = { id: 's1', grader: 'safety_label', taskType: 'message_safety', referenceOutput: { label: 'unsafe' } };
  t.eq('safety_label exact match passes', EV.score('unsafe', unsafeCase).pass, true);
  const fa = EV.score('safe', unsafeCase);
  t.eq('safety_label false allow detected', fa.falseAllow, true);
  t.eq('safety_label false allow fails', fa.pass, false);
  const safeCase = { id: 's2', grader: 'safety_label', taskType: 'message_safety', referenceOutput: { label: 'safe' } };
  t.eq('safety_label false block detected', EV.score('block', safeCase).falseBlock, true);

  // ---- grader: json_schema --------------------------------------------------
  const schemaCase = { id: 'j', grader: 'json_schema', taskType: 'tool_output', referenceOutput: { requiredFields: ['recommendation', 'confidence'], allowedEnums: { risk: ['low', 'medium', 'high'] } } };
  t.eq('json_schema valid object passes', EV.score({ recommendation: 'x', confidence: 80, risk: 'low' }, schemaCase).pass, true);
  const miss = EV.score({ confidence: 80 }, schemaCase);
  t.eq('json_schema missing required detected', miss.pass, false);
  t.ok('json_schema reports missing field', miss.missingFields.indexOf('recommendation') !== -1);
  const badEnum = EV.score({ recommendation: 'x', confidence: 80, risk: 'extreme' }, schemaCase);
  t.eq('json_schema invalid enum detected', badEnum.pass, false);
  t.ok('json_schema reports invalid field', badEnum.invalidFields.length === 1);

  // ---- grader: contains -----------------------------------------------------
  const containsCase = { id: 'c', grader: 'contains', taskType: 'followup_quality', referenceOutput: { contains: ['thank you', 'schedule'] } };
  t.eq('contains all present passes', EV.score('Thank you — can we schedule a visit?', containsCase).pass, true);
  const cmiss = EV.score('hello there', containsCase);
  t.eq('contains missing text fails', cmiss.pass, false);
  t.ok('contains reports missing phrases', cmiss.missing.length === 2);

  // ---- grader: exact --------------------------------------------------------
  const exactCase = { id: 'e', grader: 'exact', taskType: 'classification', referenceOutput: { value: 'commercial' } };
  t.eq('exact match passes', EV.score('commercial', exactCase).pass, true);
  t.eq('exact mismatch fails', EV.score('residential', exactCase).pass, false);

  // ---- runner: run() aggregation -------------------------------------------
  EV._clear();
  const c1 = EV.createCase({ id: 'r1', taskType: 'estimate_accuracy', title: 'r1', grader: 'numeric_mape', referenceOutput: { referenceValue: 100, tolerancePct: 10 }, piiCleared: true, status: 'active' });
  const c2 = EV.createCase({ id: 'r2', taskType: 'estimate_accuracy', title: 'r2', grader: 'numeric_mape', referenceOutput: { referenceValue: 200, tolerancePct: 10 }, piiCleared: true, status: 'active' });
  t.ok('runner cases created', c1.ok && c2.ok);
  const agg = EV.run('estimate_accuracy', { r1: 105, r2: 400 }); // r1 within 10%, r2 way off
  t.eq('run() n counts scored cases', agg.n, 2);
  t.eq('run() passRate aggregates', agg.passRate, 0.5);
  t.eq('run() byGrader has numeric_mape', !!agg.byGrader.numeric_mape, true);
  t.eq('run() failures lists the miss', agg.failures.length, 1);

  // ---- compareVersions: regression + block ---------------------------------
  const baseline = EV.run('estimate_accuracy', { r1: 105, r2: 205 }); // both pass
  const candidate = EV.run('estimate_accuracy', { r1: 105, r2: 400 }); // r2 regresses
  const cmp = EV.compareVersions(baseline, candidate);
  t.eq('compareVersions detects regression', cmp.regressions.length, 1);
  t.eq('compareVersions blocks promotion', cmp.shouldBlockPromotion, true);
  const cmpClean = EV.compareVersions(baseline, baseline);
  t.eq('compareVersions clean does not block', cmpClean.shouldBlockPromotion, false);

  // ---- seed ingestion (synthetic) ------------------------------------------
  EV._clear();
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/eval-golden.seed.json'), 'utf8'));
  const loaded = EV.loadSeed(seed.cases);
  t.eq('seed loads all cases', loaded.loaded, seed.cases.length);
  t.ok('seed cases are marked synthetic', EV.listCases({ includeArchived: true }).every((c) => c.synthetic === true));
  // prove the harness end-to-end on a seeded case
  t.eq('seeded mape case scores deterministically', EV.score(505, EV.getCase('seed_estimate_mape_01')).pass, true);

  return t.report();
};
