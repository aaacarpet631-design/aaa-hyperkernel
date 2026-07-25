/* Copilot eval release gate (Slice F) — the CI schema-validity / groundedness
 * gate for the HyperKernel x Custonllm contract.
 *
 * Runs the FULL systematic mutant corpus (test/helpers/copilot-mutants.js)
 * over all 5 golden fixture pairs and requires 100% kill rate: every 'schema'
 * mutant rejected by validateResponse/validateRequest, every 'integrity'
 * mutant (schema-valid fabricated evidence) flagged by
 * evidenceIntegrityIssues. Any loosening of the validator or the referential
 * guard breaks this suite, i.e. breaks CI. The 0-false-positive side: every
 * valid golden pair passes validity + groundedness + integrity, and the
 * honest-degradation fixture is ACCEPTED. The named counter-fixtures in
 * test/fixtures/copilot/invalid/ are iterated exhaustively — a fixture
 * without a declared expectation fails the gate loudly.
 * Mirrored by /workspace/custonllm/tests/test_copilot_eval_gate.py. */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, setupEnv, load, srcPath } = require('../helpers/harness');
const { generateResponseMutants, generateRequestMutants } = require('../helpers/copilot-mutants');

// filename -> expected check for every fixture in test/fixtures/copilot/invalid/
const INVALID_EXPECT = {
  'sendable-draft.json': 'schema',
  'foreign-field.json': 'schema',
  'missing-sourceref.json': 'schema',
  'unknown-cardtype.json': 'schema',
  'empty-evidence-refs.json': 'schema',
  'confidence-overflow.json': 'schema',
  'wrong-version.json': 'schema',
  'fabricated-evidence.json': 'integrity',
  'degraded-context-unavailable.response.json': 'valid'
};

module.exports = async function run() {
  const t = makeRunner('copilot-eval-gate');
  const { G } = setupEnv();
  load('js/copilot/copilot-contract.js');
  const C = G.AAA_COPILOT_CONTRACT;

  const dir = srcPath('test/fixtures/copilot');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const jobs = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.request.json'))
    .map((f) => f.replace('.request.json', ''))
    .sort();
  t.eq('all 5 golden fixture pairs are present', jobs.length, 5);
  const pairs = jobs.map((j) => ({ job: j, request: read(j + '.request.json'), response: read(j + '.response.json') }));

  // ===== 0-false-positive side: every valid pair passes EVERYTHING =====
  let validPass = 0;
  pairs.forEach((p) => {
    const ok = C.validateRequest(p.request).ok &&
      C.validateResponse(p.response).ok &&
      C.groundednessIssues(p.response).length === 0 &&
      C.evidenceIntegrityIssues(p.request, p.response).length === 0;
    if (ok) validPass++; else console.log('   valid pair failed the gate:', p.job);
  });
  t.ok('valid pairs pass validity+groundedness+integrity: ' + validPass + '/' + pairs.length + ' (0 false positives required)',
    validPass === pairs.length);

  // ===== response mutants: 100% kill rate or CI is red =====
  let schemaTotal = 0, schemaKilled = 0, integTotal = 0, integKilled = 0;
  pairs.forEach((p) => {
    generateResponseMutants(p.response).forEach((m) => {
      const v = C.validateResponse(m.mutant);
      if (m.expect === 'schema') {
        schemaTotal++;
        if (!v.ok) schemaKilled++;
        else console.log('   ESCAPED schema mutant:', p.job, m.id);
      } else {
        integTotal++;
        // integrity mutants must sail through the schema, then die on the referential guard
        const flagged = v.ok && C.evidenceIntegrityIssues(p.request, m.mutant).length > 0;
        if (flagged) integKilled++;
        else console.log('   ESCAPED integrity mutant:', p.job, m.id, '(schemaOk=' + v.ok + ')');
      }
    });
  });
  t.ok('schema-validity gate: ' + schemaKilled + '/' + schemaTotal + ' schema mutants rejected — must be 100%',
    schemaTotal > 0 && schemaKilled === schemaTotal);
  t.ok('groundedness gate: ' + integKilled + '/' + integTotal + ' fabricated-evidence mutants flagged by integrity — must be 100%',
    integTotal === pairs.length && integKilled === integTotal);

  // ===== request mutants: the ingress side of the same gate =====
  let reqTotal = 0, reqKilled = 0;
  pairs.forEach((p) => {
    generateRequestMutants(p.request).forEach((m) => {
      reqTotal++;
      if (!C.validateRequest(m.mutant).ok) reqKilled++;
      else console.log('   ESCAPED request mutant:', p.job, m.id);
    });
  });
  t.ok('request gate: ' + reqKilled + '/' + reqTotal + ' request mutants rejected — must be 100%',
    reqTotal > 0 && reqKilled === reqTotal);

  // ===== named counter-fixtures: iterate the invalid/ dir exhaustively =====
  const invDir = path.join(dir, 'invalid');
  const invFiles = fs.readdirSync(invDir).filter((f) => f.endsWith('.json')).sort();
  t.ok('every invalid-dir fixture has a declared expectation (unknown files fail the gate)',
    invFiles.length === Object.keys(INVALID_EXPECT).length && invFiles.every((f) => INVALID_EXPECT[f] != null));
  const followupsReq = pairs.filter((p) => p.job === 'followups')[0].request;
  invFiles.forEach((f) => {
    const obj = JSON.parse(fs.readFileSync(path.join(invDir, f), 'utf8'));
    const expect = INVALID_EXPECT[f];
    const v = C.validateResponse(obj);
    if (expect === 'schema') {
      t.ok('invalid/' + f + ' is rejected by the schema', v.ok === false);
    } else if (expect === 'integrity') {
      t.ok('invalid/' + f + ' is schema-VALID but flagged by evidence integrity (anti-fabrication gate)',
        v.ok === true &&
        C.evidenceIntegrityIssues(followupsReq, obj).some((i) => /EVIDENCE_NOT_IN_PACKET.*quotes:mutant_999/.test(i)));
    } else {
      // honest-degradation gate: the degraded reply must be ACCEPTED end-to-end
      t.ok('invalid/' + f + ' (honest degradation) is ACCEPTED: valid, grounded, integral',
        v.ok === true &&
        C.groundednessIssues(obj).length === 0 &&
        C.evidenceIntegrityIssues(followupsReq, obj).length === 0);
      t.ok('degraded fixture declares its degradation honestly',
        obj.degraded && obj.degraded.reason === 'context_unavailable' && obj.degraded.fallback === 'local' &&
        obj.confidence === 0 && obj.cards.length === 0 && obj.evidence.length === 0 &&
        obj.unknowns.length > 0 && !/\d/.test(obj.answer));
    }
  });

  return t.report();
};
