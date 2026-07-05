/* Workforce Registry — the roster of always-on agents.
 *
 * Guards the honest contract: malformed definitions are refused with named
 * issues (bad cadence, unroutable department, bad risk ceiling, bad
 * triggers), agents register DISABLED by default, the five safe defaults
 * seed disabled and idempotently, enable/disable flips are audited and set
 * due-ness, markRun schedules the next run from persisted state and tracks
 * health/failures/cost, and records are workspace-scoped. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('workforce-registry');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-05T09:00:00.000Z' });
  load('js/governance/audit-ledger.js');
  load('js/agents/agent-registry.js');
  load('js/agents/global-desk.js');
  load('js/agents/workforce-registry.js');
  const REG = G.AAA_WORKFORCE_REGISTRY, LED = G.AAA_AUDIT_LEDGER;

  // ===== validation refuses the classic mistakes =====
  const bad = REG.validateDef({ id: 'Bad Id!', cadence: 'sometimes', riskCeiling: 'yolo', triggers: ['whenever'], department: 'astrology' });
  t.ok('malformed def names every issue', bad.ok === false && bad.issues.length >= 6);
  t.ok('bad trigger named', bad.issues.some((s) => s.indexOf('whenever') !== -1));
  t.ok('unroutable department named', bad.issues.some((s) => s.indexOf('astrology') !== -1));

  // ===== registration: disabled by default =====
  const def = { id: 'test_agent', name: 'Test Agent', department: 'sales', purpose: 'p', mission: 'Draft things. Drafts only.', cadence: 'hourly', riskCeiling: 'low', triggers: ['schedule', 'event:lead.created'] };
  const r1 = await REG.register(def);
  t.ok('valid agent registers', r1.ok === true && r1.agent.persona === 'sales');
  t.eq('registers DISABLED by default', r1.agent.enabled, false);
  t.eq('disabled agent is paused', r1.agent.status, 'paused');
  t.eq('duplicate id refused', (await REG.register(def)).error, 'ALREADY_REGISTERED');
  t.ok('registration is audited', (await G.AAA_DATA.list('governance_audit')).some((e) => e.type === 'workforce.agent.registered'));

  // ===== enable/disable =====
  const en = await REG.setEnabled('test_agent', true);
  t.ok('enable flips status to idle and sets due-ness', en.agent.enabled === true && en.agent.status === 'idle' && en.agent.nextRunAt === '2026-07-05T09:00:00.000Z');
  const dis = await REG.setEnabled('test_agent', false);
  t.ok('disable pauses', dis.agent.enabled === false && dis.agent.status === 'paused');
  t.ok('the audit chain verifies across flips', (await LED.verify()).ok === true);

  // ===== markRun: persisted schedule math + health =====
  await REG.setEnabled('test_agent', true);
  const m1 = await REG.markRun('test_agent', { ok: true, costUsd: 0.05 });
  t.eq('next run = now + hourly cadence', m1.agent.nextRunAt, '2026-07-05T10:00:00.000Z');
  t.ok('run + cost counted', m1.agent.runs === 1 && m1.agent.costUsd === 0.05);
  const m2 = await REG.markRun('test_agent', { ok: false });
  t.ok('one failure degrades health', m2.agent.failures === 1 && m2.agent.health === 'degraded');
  await REG.markRun('test_agent', { ok: false });
  const m4 = await REG.markRun('test_agent', { ok: false });
  t.eq('three failures → failing', m4.agent.health, 'failing');
  const m5 = await REG.markRun('test_agent', { ok: true });
  t.ok('a clean run restores health, keeps failure history', m5.agent.health === 'ok' && m5.agent.failures === 3);

  // ===== the five safe defaults =====
  const seeded = await REG.seedDefaults();
  t.eq('five defaults installed', seeded.installed, 5);
  const all = await REG.list();
  t.eq('registry lists six agents', all.length, 6);
  t.ok('every default is DISABLED and low-risk', all.filter((a) => a.id !== 'test_agent').every((a) => a.enabled === false && a.riskCeiling === 'low'));
  t.ok('every default mission is draft-only by text', all.filter((a) => a.id !== 'test_agent').every((a) => /draft|summary|recommend/i.test(a.mission)));
  t.eq('re-seeding is idempotent', (await REG.seedDefaults()).installed, 0);
  t.eq('list filters by enabled', (await REG.list({ enabled: true })).length, 1);

  // ===== workspace scoping =====
  cfg.set({ workspaceId: 'ws_other' });
  t.eq('another workspace sees nothing', (await REG.list()).length, 0);
  t.eq('cross-workspace get is null', await REG.get('test_agent'), null);
  cfg.set({ workspaceId: 'ws_test' });

  // ===== cadence math =====
  t.eq('15m cadence', REG.cadenceMs('15m'), 900000);
  t.eq('numeric cadence accepted', REG.cadenceMs(120000), 120000);
  t.eq('sub-minute cadence refused', REG.cadenceMs(1000), null);

  return t.report();
};
