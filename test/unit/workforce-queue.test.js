/* Workforce Queue — the auditable job ledger.
 *
 * Guards the honest contract: jobs are born 'queued' with full identity,
 * the state machine is deterministic (illegal transitions refused by name —
 * no teleporting from queued to completed), timestamps are queue-set,
 * every transition chains into the audit ledger with refs recorded on the
 * job, retry/unblock resets are explicit, and listing is workspace-scoped
 * and filterable. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('workforce-queue');
  const { G, cfg } = setupEnv();
  load('js/governance/audit-ledger.js');
  load('js/agents/workforce-queue.js');
  const Q = G.AAA_WORKFORCE_QUEUE, LED = G.AAA_AUDIT_LEDGER;

  // ===== birth =====
  t.eq('a job needs an agent', (await Q.enqueue({})).error, 'NO_AGENT');
  const e1 = await Q.enqueue({ agentId: 'lead_watcher', trigger: 'schedule', inputSummary: 'Review recent leads' });
  const j1 = e1.job;
  t.ok('job is born queued with identity', e1.ok === true && j1.status === 'queued' && j1.agentId === 'lead_watcher' && j1.trigger === 'schedule' && !!j1.createdAt);
  t.ok('birth is audited with the ref on the job', j1.auditRefs.length === 1);
  t.ok('no timestamps invented at birth', j1.startedAt === null && j1.endedAt === null);

  // ===== deterministic transitions =====
  const teleport = await Q.transition(j1.id, 'completed');
  t.ok('queued cannot teleport to completed', teleport.error === 'BAD_TRANSITION' && teleport.allowed.indexOf('running') !== -1);
  const run1 = await Q.transition(j1.id, 'running', { missionId: 'mission_1', risk: 'low' });
  t.ok('queued → running sets startedAt + mission + risk', run1.ok === true && !!run1.job.startedAt && run1.job.missionId === 'mission_1' && run1.job.governance.risk === 'low');
  t.eq('running cannot go back to queued', (await Q.transition(j1.id, 'queued')).error, 'BAD_TRANSITION');
  const wait1 = await Q.transition(j1.id, 'awaiting_approval', { outputSummary: 'paused for human', governanceNote: 'gate' });
  t.ok('running → awaiting_approval records output + note', wait1.ok === true && wait1.job.outputSummary === 'paused for human' && wait1.job.governance.notes.length === 1);
  const done1 = await Q.transition(j1.id, 'completed');
  t.ok('awaiting_approval → completed sets endedAt', done1.ok === true && !!done1.job.endedAt);
  t.eq('completed is terminal', (await Q.transition(j1.id, 'queued')).error, 'BAD_TRANSITION');

  // ===== failure, retry, block, unblock =====
  const e2 = await Q.enqueue({ agentId: 'estimate_guardian' });
  await Q.transition(e2.job.id, 'running');
  const fail = await Q.transition(e2.job.id, 'failed', { error: 'AI_NOT_CONFIGURED' });
  t.ok('failure records the error and ends', fail.job.error === 'AI_NOT_CONFIGURED' && !!fail.job.endedAt);
  const retry = await Q.transition(e2.job.id, 'queued');
  t.ok('retry is explicit and resets error + end', retry.ok === true && retry.job.error === null && retry.job.endedAt === null);
  await Q.transition(e2.job.id, 'running');
  const block = await Q.transition(e2.job.id, 'blocked', { error: 'RISK_CEILING' });
  t.ok('blocked keeps its cause', block.job.error === 'RISK_CEILING');
  t.ok('blocked can requeue or cancel only', (await Q.transition(e2.job.id, 'completed')).error === 'BAD_TRANSITION');
  const cancel = await Q.transition(e2.job.id, 'cancelled');
  t.ok('blocked → cancelled is terminal', cancel.ok === true && (await Q.transition(e2.job.id, 'running')).error === 'BAD_TRANSITION');

  // ===== every transition is chained =====
  const audited = (await G.AAA_DATA.list('governance_audit')).filter((e) => String(e.type).indexOf('workforce.job.') === 0);
  t.ok('every transition landed in the ledger', audited.length >= 10);
  t.ok('the audit chain verifies', (await LED.verify()).ok === true);
  t.ok('job carries its audit refs', (await Q.get(e2.job.id)).auditRefs.length >= 5);

  // ===== listing =====
  t.eq('list by agent', (await Q.list({ agentId: 'lead_watcher' })).length, 1);
  t.eq('list by status', (await Q.list({ status: 'cancelled' })).length, 1);
  cfg.set({ workspaceId: 'ws_other' });
  t.eq('another workspace sees no jobs', (await Q.list()).length, 0);
  t.eq('cross-workspace get is null', await Q.get(j1.id), null);
  cfg.set({ workspaceId: 'ws_test' });
  t.eq('unknown job → NOT_FOUND', (await Q.transition('nope', 'running')).error, 'NOT_FOUND');

  return t.report();
};
