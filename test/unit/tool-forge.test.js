/* Tool Forge — dynamic interface generation: Tool DNA, agent-bound single-use
 * tools, mechanical enforcement, BYOT governance, discard-at-termination, and
 * the Sync-Reconciler + hardware-telemetry scenarios. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('tool-forge');
  const { G, data } = setupEnv();
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-engine.js');
  load('js/genesis/agent-template-schema.js');
  load('js/genesis/capability-registry.js');
  load('js/genesis/capability-gap-detector.js');
  load('js/genesis/agent-factory.js');
  load('js/genesis/spawn-policy.js');
  load('js/genesis/tool-forge.js');
  load('js/genesis/ephemeral-agent-runtime.js');
  load('js/genesis/promotion-engine.js');
  load('js/genesis/termination-engine.js');
  load('js/genesis/genesis-council.js');
  const FORGE = G.AAA_TOOL_FORGE, FAC = G.AAA_AGENT_FACTORY, RT = G.AAA_EPHEMERAL_RUNTIME;
  const COUNCIL = G.AAA_GENESIS_COUNCIL, GAP = G.AAA_GAP_DETECTOR, TPL = G.AAA_AGENT_TEMPLATE;

  // ===== Tool DNA registries =====
  t.ok('protocol registry (GraphQL/REST/Cypher/Local_RPC/BLE_Telemetry)', ['GraphQL', 'REST', 'Cypher', 'Local_RPC', 'BLE_Telemetry'].every((p) => FORGE.PROTOCOLS.indexOf(p) !== -1));
  t.ok('target registry (KnowledgeGraph/PWALedger/SquarespaceWebhook/HardwareSensor)', ['KnowledgeGraph', 'PWALedger', 'SquarespaceWebhook', 'HardwareSensor'].every((x) => FORGE.TARGETS.indexOf(x) !== -1));
  t.ok('action registry (Mutate/Query/Validate/Revert/Hash)', ['Mutate', 'Query', 'Validate', 'Revert', 'Hash'].every((a) => FORGE.ACTIONS.indexOf(a) !== -1));
  t.ok('forged_tools + tool_invocations are protected from agent writes', TPL.PROTECTED_WRITES.indexOf('forged_tools') !== -1 && TPL.PROTECTED_WRITES.indexOf('tool_invocations') !== -1);

  // ===== Scenario A: Sync-Reconciler + Mutate_Offline_Queue =====
  GAP.defineTrigger('sync.queue_flushed', (p) => ({ action: 'verify', entity: 'job', context: 'offline sync queue', domain: 'operations' }));
  const spliced = FAC.splice({ action: 'verify', entity: 'job', context: 'offline sync queue', domain: 'operations', triggerEvent: 'sync.queue_flushed' });
  t.ok('sync-reconciler genome splices', spliced.ok === true && /offline-job-verification-agent/.test(spliced.spec.name));
  const spec = spliced.spec;
  const runId = 'run_test_A';
  const tools = await FORGE.forgeFor(spec, runId);
  t.ok('forge compiles a bound toolset at spawn time', tools.length >= 4);
  const mutator = tools.find((x) => x.action === 'Mutate');
  t.eq('the ledger mutator is named from its DNA', mutator.name, FORGE.nameFor('mutate', mutator.binding.collection));
  t.ok('mutator is single-use and run-bound', mutator.maxInvocations === 1 && mutator.boundRunId === runId && mutator.boundAgentId === spec.agentId);
  t.ok('every forged bridge lands in the knowledge graph (agent —forged→ tool)', (await data.list('graph_facts')).filter((f) => f.rel === 'forged').length >= 4);

  const me = { agentId: spec.agentId, runId: runId };
  const bad = await FORGE.invoke(mutator.id, { wrong: 'shape' }, me);
  t.ok('args failing the tool inputSchema are rejected', bad.ok === false && bad.error === 'INVALID_ARGS');
  const good = await FORGE.invoke(mutator.id, { result: 'queue reconciled: 14 cached actions applied', confidence: 95 }, me);
  t.ok('valid invocation mutates the bound ledger collection', good.ok === true && /:/.test(good.written));
  const again = await FORGE.invoke(mutator.id, { result: 'again', confidence: 90 }, me);
  t.eq('single-use: the second swing of the wrench is refused', again.error, 'TOOL_EXHAUSTED');
  const thief = await FORGE.invoke(mutator.id, { result: 'x', confidence: 1 }, { agentId: 'someone_else', runId: runId });
  t.eq('another agent cannot use a bound tool', thief.error, 'TOOL_NOT_YOURS');
  t.ok('every invocation (incl. failures and theft attempts) is logged', (await FORGE.invocations(mutator.id)).length === 4);
  const hasher = tools.find((x) => x.action === 'Hash');
  const h1 = await FORGE.invoke(hasher.id, { payload: { a: 1, b: 2 } }, me);
  const h2 = await FORGE.invoke(hasher.id, { payload: { b: 2, a: 1 } }, me);
  t.eq('hash tool is canonical (key order independent)', h1.hash, h2.hash);

  // ===== Scenario B: BYOT — hardware telemetry, fail-closed =====
  const dna = { protocol: 'BLE_Telemetry', target: 'HardwareSensor', action: 'Query', name: 'query_stapler_burn_rate', inputSchema: { required: ['truckId'], properties: { truckId: { type: 'string' } } } };
  const req = await FORGE.request(spec, dna, { runId: runId, justification: 'burn-rate analysis' });
  t.ok('external-protocol BYOT request is HELD, not forged', req.ok === false && req.held && req.held.status === 'held');
  t.eq('release without a written reason is refused', (await FORGE.approveRequest(req.held.id, { reason: 'ok' })).error, 'JUSTIFICATION_REQUIRED');
  const approved = await FORGE.approveRequest(req.held.id, { reason: 'Roberts stapler telemetry is read-only inventory data.' });
  t.ok('human approval forges the tool', approved.ok === true && approved.tool.name === 'query_stapler_burn_rate');
  const unbound = await FORGE.invoke(approved.tool.id, { truckId: 'truck7' }, me);
  t.eq('no driver → honest TOOL_TARGET_UNBOUND (telemetry is never simulated)', unbound.error, 'TOOL_TARGET_UNBOUND');
  FORGE.registerHandler('BLE_Telemetry', 'HardwareSensor', async (args) => ({ ok: true, truckId: args.truckId, staplesPerHour: 412 }));
  const live = await FORGE.invoke(approved.tool.id, { truckId: 'truck7' }, me);
  t.ok('with a registered driver the telemetry tool reads hardware', live.ok === true && live.staplesPerHour === 412);
  const fake = await FORGE.request(spec, { protocol: 'Telepathy', target: 'HardwareSensor', action: 'Query' }, {});
  t.ok('a hallucinated protocol cannot be requested into existence', fake.ok === false && fake.error === 'INVALID_TOOL_DNA');
  const internal = await FORGE.request(spec, { protocol: 'Local_RPC', target: 'KnowledgeGraph', action: 'Query' }, { runId: runId });
  t.ok('internal Local_RPC BYOT forges immediately (no hold)', internal.ok === true);

  // ===== end-to-end: the runtime hands the toolkit to the executor =====
  let seenToolkit = null;
  RT.setExecutor({
    name: 'tool-user',
    run: async (s, task, ctx, toolkit) => {
      seenToolkit = toolkit;
      const q = toolkit.tools.find((x) => x.action === 'Query');
      const facts = await toolkit.invoke(q.id, { rel: 'forged', limit: 5 });
      return { ok: true, output: { assessment: 'used ' + facts.facts.length + ' graph facts', indicates: 'BleachDamage', severity: 'minor', confidence: 75 }, costUsd: 0.01 };
    }
  });
  const demo = await COUNCIL.handleEvent('photo.uploaded', { photoId: 'phT', tags: ['bleach'] });
  t.ok('executor received the bound toolkit (tools + invoke + request)', !!seenToolkit && Array.isArray(seenToolkit.tools) && typeof seenToolkit.invoke === 'function' && typeof seenToolkit.request === 'function');
  t.eq('the run succeeded using only forged tools', demo.run.status, 'succeeded');

  // ===== discard at termination: the wrench dissolves with the hand =====
  t.ok('termination discarded the run’s tools', demo.run.toolsDiscarded >= 4);
  const demoTool = (await FORGE.tools({ runId: demo.run.id }))[0];
  const after = await FORGE.invoke(demoTool.id, {}, { agentId: demo.spec.agentId, runId: demo.run.id });
  t.eq('a discarded tool refuses forever', after.error, 'TOOL_DISCARDED');
  t.ok('…but its definition + audit trail remain (nothing dissolves silently)', demoTool.discarded === true && (await data.list('governance_audit')).some((a) => a.type === 'genesis.tool_discarded'));
  const auditTypes = (await data.list('governance_audit')).map((a) => a.type);
  t.ok('audit ledger holds the full tool lifecycle', ['genesis.tool_forged', 'genesis.tool_request_held', 'genesis.tool_request_approved', 'genesis.tool_discarded'].every((ty) => auditTypes.indexOf(ty) !== -1));

  return t.report();
};
