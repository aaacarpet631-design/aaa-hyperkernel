/*
 * AAA test runner — runs every unit suite + static integrity + boot smoke, plus
 * the function pure-logic suites, and exits non-zero on any failure. Zero deps.
 *
 * Each internal suite runs in its own child process (so globals don't leak) and
 * prints a machine-readable "RESULT <name> <pass> <fail>" line we parse.
 */
'use strict';
const path = require('path');
const cp = require('child_process');

const SUITES = [
  'unit/rbac.test.js',
  'unit/gateway.test.js',
  'unit/model-router.test.js',
  'unit/action-safety-gate.test.js',
  'unit/pricing.test.js',
  'unit/huepar-s60.test.js',
  'unit/capture-sequencer.test.js',
  'unit/bluetooth-connect.test.js',
  'unit/closure.test.js',
  'unit/accounting.test.js',
  'unit/expense-classifier.test.js',
  'unit/receipt-intake.test.js',
  'unit/controller-agent.test.js',
  'unit/financial-intelligence-ui.test.js',
  'unit/estimator-agent.test.js',
  'unit/estimator-ui.test.js',
  'unit/quote-store.test.js',
  'unit/quote-lifecycle-ui.test.js',
  'unit/outcome-learning.test.js',
  'unit/pricing-optimizer.test.js',
  'unit/pricing-optimizer-ui.test.js',
  'unit/prediction-closure.test.js',
  'unit/learning-feedback-ui.test.js',
  'unit/calibration-registry.test.js',
  'unit/calibration-ui.test.js',
  'unit/calibration-runtime.test.js',
  'unit/transport-templates.test.js',
  'unit/transport-store.test.js',
  'unit/transport-dashboard-ui.test.js',
  'unit/transport-delivery.test.js',
  'unit/transport-scheduler.test.js',
  'unit/transport-native.test.js',
  'unit/transport-inbox-ui.test.js',
  'unit/security.test.js',
  'unit/security-ui.test.js',
  'unit/event-bus.test.js',
  'unit/event-stream-ui.test.js',
  'unit/privacy.test.js',
  'unit/privacy-dashboard-ui.test.js',
  'unit/agent-council.test.js',
  'unit/agent-council-ui.test.js',
  'unit/provenance.test.js',
  'unit/provenance-ui.test.js',
  'unit/governance-registry.test.js',
  'unit/governance-registry-ui.test.js',
  'unit/replay-sandbox.test.js',
  'unit/replay-sandbox-ui.test.js',
  'unit/legal.test.js',
  'unit/legal-war-room-ui.test.js',
  'unit/crew-tools.test.js',
  'unit/scheduling.test.js',
  'unit/contracts.test.js',
  'unit/quickbooks-online.test.js',
  'unit/portal-links.test.js',
  'unit/voice.test.js',
  'unit/transcribe.test.js',
  'unit/research-brain.test.js',
  'static/integrity.test.js',
  'smoke/boot.test.js'
];

// Self-contained pure-logic suites next to their function source; they print
// "N passed, M failed" and exit non-zero on failure.
const EXTERNAL = [
  'functions/qbo-proxy/test.js',
  'functions/portal-proxy/test.js',
  'functions/nemotron-translate.test.js'
];

function runSuite(rel) {
  const out = cp.spawnSync(process.execPath, [path.join(__dirname, 'run-one.js'), rel], { encoding: 'utf8' });
  const m = (out.stdout || '').match(/RESULT (\S+) (\d+) (\d+)/);
  const pass = m ? Number(m[2]) : 0;
  const fail = m ? Number(m[3]) : 1;
  const name = m ? m[1] : rel;
  console.log('[' + name + '] ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.stdout.write(scrub(out.stdout) + (out.stderr || ''));
  return { name: name, pass: pass, fail: fail };
}

function runExternal(rel) {
  const out = cp.spawnSync(process.execPath, [path.join(__dirname, '..', rel)], { encoding: 'utf8' });
  const m = (out.stdout || '').match(/(\d+) passed, (\d+) failed/);
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : (out.status === 0 ? 0 : 1);
  console.log('[' + rel + '] ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.stdout.write((out.stdout || '') + (out.stderr || ''));
  return { name: rel, pass: pass, fail: fail };
}

// Drop the machine-readable RESULT line from human output.
function scrub(s) { return (s || '').split('\n').filter((l) => !/^RESULT /.test(l)).join('\n'); }

const results = [];
SUITES.forEach((s) => results.push(runSuite(s)));
EXTERNAL.forEach((s) => results.push(runExternal(s)));

const totalPass = results.reduce((n, r) => n + r.pass, 0);
const totalFail = results.reduce((n, r) => n + r.fail, 0);
console.log('\n' + '='.repeat(48));
console.log('TOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed across ' + results.length + ' suites');
if (totalFail > 0) {
  console.log('FAILED SUITES: ' + results.filter((r) => r.fail > 0).map((r) => r.name).join(', '));
  process.exit(1);
}
console.log('ALL GREEN');
