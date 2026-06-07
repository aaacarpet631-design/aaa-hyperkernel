/* Sensing Ingress — signals become recorded, audited, advisory owner-queue drafts (never sent). */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

async function activateInstruct(G) {
  const R = G.AAA_GOVERNED_MODEL_ROUTER, GOV = G.AAA_GOVERNANCE;
  const prov = await R.provision('nvidia.nemotron4_340b_instruct', { actor: 'owner', modelId: 'nvidia/nemotron-4-340b-instruct', verifiedId: true });
  await GOV.approve(prov.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prov.governanceVersionId, { actor: 'owner' });
  await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { actor: 'owner' });
}

module.exports = async function run() {
  const t = makeRunner('sensing');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/core/aaa-events.js');
  load('js/core/aaa-event-bus.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/ai/model-registry.js');
  load('js/ai/model-call-provenance.js');
  load('js/ai/providers/nvidia-nemotron-adapter.js');
  load('js/ai/model-router.js');
  load('js/ai/assisted-draft-queue.js');
  load('js/core/sensing-ingress.js');
  const S = G.AAA_SENSING;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const DR = G.AAA_ASSISTED_DRAFTS;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');
  await activateInstruct(G);

  // ===== inbound SMS → recorded + advisory draft (pending owner) =====
  const r = await S.ingest({ type: 'inbound_sms', externalId: 'SM1', source: 'twilio', payload: { from: '+15551112222', to: '+15559990000', body: 'is tomorrow ok?' } }, { actor: 'sensing' });
  t.ok('an inbound SMS is sensed + routed', r.ok === true && r.sensed.status === 'routed' && r.advisory === true);
  t.ok('it created a PENDING owner-approval draft (not a send)', !!r.draftId && (await DR.get(r.draftId)).status === 'pending_owner');
  t.ok('the suggested reply is addressed to the sender', (await DR.get(r.draftId)).to === '+15551112222');

  // ===== the signal is recorded + audited + on the event log =====
  t.ok('the sensed signal is recorded', (await S.list()).some((s) => s.externalId === 'SM1'));
  t.ok('ingestion is audited (SENSE_SIGNAL)', (await GW.recentAudit(100)).some((a) => a.action === 'SENSE_SIGNAL' && a.decision === 'allowed'));
  t.ok('the signal is on the immutable event log', (await G.AAA_EVENT_BUS.verifyChain()).length >= 1 && (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'sensing.inbound_sms'));

  // ===== idempotency: the same webhook firing twice does not double-act =====
  const dup = await S.ingest({ type: 'inbound_sms', externalId: 'SM1', source: 'twilio', payload: { from: '+15551112222', body: 'is tomorrow ok?' } }, { actor: 'sensing' });
  t.ok('a duplicate webhook is de-duplicated', dup.ok === true && dup.already === true);
  t.eq('no duplicate draft was created', (await DR.list()).filter((d) => d.to === '+15551112222').length, 1);

  // ===== missed call + web lead also produce advisory drafts =====
  const mc = await S.ingest({ type: 'missed_call', externalId: 'CA1', source: 'twilio', payload: { from: '+15553334444', status: 'no-answer' } }, { actor: 'sensing' });
  t.ok('a missed call drafts a follow-up (pending owner)', mc.ok === true && !!mc.draftId && (await DR.get(mc.draftId)).intent === 'missed_call_followup');
  const lead = await S.ingest({ type: 'web_lead', externalId: 'L1', source: 'web_form', payload: { name: 'Jane', phone: '+15555556666', message: 'need a quote' } }, { actor: 'sensing' });
  t.ok('a web lead drafts a first-contact (pending owner)', lead.ok === true && !!lead.draftId && (await DR.get(lead.draftId)).status === 'pending_owner');

  // ===== nothing was sent autonomously =====
  t.ok('every resulting draft is still pending owner approval (no autonomous send)', (await DR.list()).every((d) => d.status === 'pending_owner'));

  // ===== unknown signal type is refused =====
  t.eq('an unknown signal type is rejected', (await S.ingest({ type: 'mystery', externalId: 'x' })).error, 'UNKNOWN_SIGNAL');

  // ===== metrics =====
  const m = await S.metrics();
  t.ok('metrics summarize sensed signals + drafts', m.total >= 3 && m.byType.inbound_sms >= 1 && m.draftsCreated >= 3);

  return t.report();
};
