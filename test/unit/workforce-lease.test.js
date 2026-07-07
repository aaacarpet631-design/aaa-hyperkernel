/* Workforce Lease — mutual exclusion for an at-least-once world.
 *
 * Guards the honest contract: a live lease held by another owner is a
 * refusal that NAMES the holder and expiry; re-acquiring your own lease is
 * fine; expired leases are taken over with an AUDITED takeover record;
 * renew/release are owner-checked; leases are workspace-scoped. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('workforce-lease');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-05T09:00:00.000Z' });
  load('js/governance/audit-ledger.js');
  load('js/agents/workforce-lease.js');
  const L = G.AAA_WORKFORCE_LEASE;

  // ===== acquire / contention =====
  t.eq('a lease needs a name and owner', (await L.acquire('x', {})).error, 'BAD_LEASE');
  const a1 = await L.acquire('workforce.tick', { owner: 'runner_a', ttlMs: 60000 });
  t.ok('first acquire wins with expiry set', a1.ok === true && a1.lease.owner === 'runner_a' && a1.lease.expiresAt === '2026-07-05T09:01:00.000Z');
  const a2 = await L.acquire('workforce.tick', { owner: 'runner_b' });
  t.ok('a live lease refuses others and NAMES the holder', a2.ok === false && a2.error === 'LEASE_HELD' && a2.holder === 'runner_a' && !!a2.expiresAt);
  const a3 = await L.acquire('workforce.tick', { owner: 'runner_a', ttlMs: 120000 });
  t.ok('re-acquiring your own lease is fine (extends)', a3.ok === true && a3.takeover === false);

  // ===== renew / release are owner-checked =====
  t.eq('a stranger cannot renew', (await L.renew('workforce.tick', 'runner_b')).error, 'NOT_OWNER');
  t.ok('the owner can renew', (await L.renew('workforce.tick', 'runner_a', 60000)).ok === true);
  t.eq('a stranger cannot release', (await L.release('workforce.tick', 'runner_b')).error, 'NOT_OWNER');
  t.ok('the owner can release', (await L.release('workforce.tick', 'runner_a')).ok === true);
  const afterRelease = await L.acquire('workforce.tick', { owner: 'runner_b' });
  t.ok('after release the next runner acquires', afterRelease.ok === true && afterRelease.lease.owner === 'runner_b');
  await L.release('workforce.tick', 'runner_b');

  // ===== expired leases are taken over, AUDITED =====
  const dead = await L.acquire('agent:drafter', { owner: 'dead_runner', ttlMs: 60000 });
  t.ok('dead runner held the lease', dead.ok === true);
  // move the clock past expiry
  G.AAA_RUNTIME_CLOCK = { now: () => Date.parse('2026-07-05T09:05:00.000Z'), nowISO: () => '2026-07-05T09:05:00.000Z' };
  const steal = await L.acquire('agent:drafter', { owner: 'runner_c', ttlMs: 60000 });
  t.ok('expired lease is taken over', steal.ok === true && steal.takeover === true && steal.lease.takeovers === 1);
  t.ok('the takeover is audited (a dead runner is visible)', (await G.AAA_DATA.list('governance_audit')).some((e) => e.type === 'workforce.lease.takeover' && e.payload.from === 'dead_runner'));
  t.ok('releasing an unheld name is a calm no-op', (await L.release('never_acquired', 'x')).ok === true);

  // ===== workspace scoping =====
  cfg.set({ workspaceId: 'ws_other' });
  const cross = await L.acquire('agent:drafter', { owner: 'other_tenant_runner' });
  t.ok('another workspace has its own lease namespace', cross.ok === true && cross.takeover === false);
  cfg.set({ workspaceId: 'ws_test' });
  t.ok('the original workspace lease is untouched', (await L.get('agent:drafter')).owner === 'runner_c');

  return t.report();
};
