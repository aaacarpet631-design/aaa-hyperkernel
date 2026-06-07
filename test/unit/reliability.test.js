/* Reliability Command Center — metric aggregation, health, alerts, trends, incident timeline. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('reliability');
  const { G, data } = setupEnv();
  load('js/intelligence/reliability-center.js');
  const R = G.AAA_RELIABILITY;

  // ===== null-tolerance: no modules loaded → unknown metrics, never throws =====
  const bare = await R.metrics();
  t.ok('metrics() is null-tolerant with no modules present', Array.isArray(bare));
  const h0 = await R.health();
  t.ok('health() degrades gracefully', h0.ok === true && typeof h0.metrics === 'number' && ['ok', 'warn', 'crit', 'unknown'].indexOf(h0.status) !== -1);

  // ===== wire up stub signal sources =====
  G.AAA_TRANSPORT = { stats: async () => ({ sent: 2, delivered: 5, failed: 4, bounced: 0, pendingApproval: 12, queued: 3, canceled: 0, pendingRetry: 1 }) };
  G.AAA_OUTCOME_LEARNING = { aggregate: async () => ({ overall: { winRate: 0.08, resolved: 25, avgMarginPct: 20 } }) };
  G.AAA_PREDICTION_CLOSURE = { calibrationSummary: async () => ({ agents: [{ validationRate: 0.7, validated: 7, contradicted: 3, closures: 10 }] }) };
  G.AAA_SUPERVISOR = { metrics: async () => ({ perAgent: { estimator: { avgScore: 0.8 }, risk: { avgScore: 0.6 } } }) };
  G.AAA_EVENT_BUS = { verifyChain: async () => ({ ok: true, length: 5, breaks: [] }) };
  G.AAA_SECURITY = { verifyAuditChain: async () => ({ ok: false, length: 9, breaks: [{ seq: 3, reason: 'hash_mismatch' }] }) };

  const m = await R.metrics();
  const get = (k) => m.find((x) => x.key === k);
  t.ok('transport failure rate computed (4/11 ~ 36% → crit)', get('transport_failure_rate').value === 36 && get('transport_failure_rate').status === 'crit');
  t.ok('queue backlog flagged (15 → warn)', get('queue_backlog').value === 15 && get('queue_backlog').status === 'warn');
  t.ok('conversion crit at 8%', get('conversion_rate').value === 8 && get('conversion_rate').status === 'crit');
  t.ok('prediction accuracy ok at 70%', get('prediction_accuracy').value === 70 && get('prediction_accuracy').status === 'ok');
  t.ok('agent accuracy averaged (70%)', get('agent_accuracy').value === 70);
  t.ok('event-log integrity ok', get('event_chain').status === 'ok');
  t.ok('audit-log tamper surfaces as crit', get('audit_chain').status === 'crit');

  // ===== health + alerts =====
  const h = await R.health();
  t.ok('overall health is crit when any metric is crit', h.status === 'crit' && typeof h.score === 'number');
  const alerts = await R.alerts();
  t.ok('alerts list warn + crit, crit first', alerts.length >= 3 && alerts[0].status === 'crit' && alerts.every((a) => a.status !== 'ok'));

  // ===== snapshots + trends =====
  await R.snapshot();
  await R.snapshot();
  t.ok('snapshots persist for trends', (await R.snapshots()).length === 2);
  const tr = await R.trend('transport_failure_rate');
  t.ok('trend returns the metric over time', tr.length === 2 && tr[0].value === 36);

  // ===== incident timeline =====
  const ev = await R.evaluate();
  t.ok('evaluate opens incidents for crit alerts', ev.ok === true && ev.opened >= 2 && ev.openTotal >= 2);
  const ev2 = await R.evaluate();
  t.ok('evaluate is idempotent (no duplicate incidents)', ev2.opened === 0 && ev2.openTotal === ev.openTotal);
  const openInc = await R.incidents('open');
  t.ok('open incidents carry metric key + occurrences', openInc.some((i) => i.metricKey === 'transport_failure_rate' && i.occurrences >= 2));
  const res = await R.resolveIncident(openInc[0].id, { actor: 'owner', note: 'fixed provider' });
  t.ok('an incident can be resolved (timeline)', res.ok === true && res.incident.status === 'resolved' && res.incident.resolvedBy === 'owner');
  t.eq('resolved incident leaves the open list', (await R.incidents('open')).length, openInc.length - 1);

  // manual incident
  const man = await R.recordIncident({ title: 'Webhook outage', severity: 'crit', actor: 'owner' });
  t.ok('a manual incident can be recorded', man.ok === true && (await R.incidents('open')).some((i) => i.id === man.incident.id));

  return t.report();
};
