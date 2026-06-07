/* Reliability — private GPU model health surfaces in the metrics (and goes crit when the breaker opens). */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('reliability-gpu-health');
  const { G } = setupEnv();
  load('js/intelligence/reliability-center.js');
  load('js/ai/providers/private-gpu-adapter.js');
  load('js/ai/providers/private-gpu-transport.js');
  const R = G.AAA_RELIABILITY, T = G.AAA_PRIVATE_GPU_TRANSPORT;

  // ===== not installed → no GPU metric (offline-safe) =====
  const m0 = await R.metrics();
  t.ok('no GPU metric when the provider is not installed', !m0.some((x) => x.key === 'gpu_model_health'));

  // ===== installed + healthy → an "online" ok metric appears =====
  T.install({ endpoint: '/api/private-gpu', fetch: async () => ({ json: async () => ({ ok: true, text: 'hi' }) }), failThreshold: 2 });
  const m1 = await R.metrics();
  const g1 = m1.find((x) => x.key === 'gpu_model_health');
  t.ok('GPU health metric is present + online when installed', !!g1 && g1.status === 'ok' && /online/.test(String(g1.value)));

  // ===== breaker open (GPU down) → metric goes crit → overall health crit =====
  T.uninstall();
  T.install({ endpoint: '/api/private-gpu', fetch: async () => { throw new Error('down'); }, failThreshold: 1, retryCap: 0, cooldownMs: 60000 });
  await T.send({ taskType: 'x', modelId: 'm', input: 'y' });  // one failure → opens (threshold 1)
  const m2 = await R.metrics();
  const g2 = m2.find((x) => x.key === 'gpu_model_health');
  t.ok('a down GPU surfaces as a critical metric', g2 && g2.status === 'crit' && /unavailable/.test(String(g2.value)));
  const health = await R.health();
  t.ok('overall reliability reflects the GPU outage', health.status === 'crit');
  const alerts = await R.alerts();
  t.ok('the GPU outage raises an alert', alerts.some((a) => a.key === 'gpu_model_health' && a.status === 'crit'));

  T.uninstall();
  return t.report();
};
