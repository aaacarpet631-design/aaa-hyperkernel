/* Assisted Draft Queue — Instruct drafts, owner approves, nothing auto-sends. */
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
  const t = makeRunner('assisted-draft-queue');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/ai/model-registry.js');
  load('js/ai/model-call-provenance.js');
  load('js/ai/providers/nvidia-nemotron-adapter.js');
  load('js/ai/model-router.js');
  load('js/ai/assisted-draft-queue.js');
  const Q = G.AAA_ASSISTED_DRAFTS;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');
  await activateInstruct(G);

  // ===== draft via the governed Instruct model → pending, provenance-linked =====
  const d = await Q.draft({ customerId: 'c1', customerName: 'Jane', to: '+15551112222', channel: 'sms', intent: 'follow_up', actor: 'owner' });
  t.ok('a draft is filed pending owner approval', d.ok === true && d.draft.status === 'pending_owner' && !!d.draft.suggestedText);
  t.ok('the draft carries the governed model envelope', !!d.draft.model.governanceVersion && !!d.draft.model.outputChecksum && d.draft.model.provider === 'nvidia');
  t.ok('the draft links a provenance trace', !!d.draft.model.provenanceTraceId && (await G.AAA_PROVENANCE.get(d.draft.model.provenanceTraceId)) !== null);
  t.ok('drafting is on the pending list', (await Q.pending()).some((x) => x.id === d.draft.id));
  t.eq('a draft needs a recipient', (await Q.draft({ customerId: 'c1', actor: 'owner' })).error, 'NO_RECIPIENT');

  // ===== crew cannot draft (RUN_MODEL denies, audited) =====
  RB.setRole('crew');
  t.eq('crew cannot draft (model inference denied)', (await Q.draft({ to: '+1555', actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');

  // ===== AI can request a draft but can NEVER approve it =====
  const aiDraft = await Q.draft({ to: '+15551110000', intent: 'review_request', origin: 'ai' });
  t.ok('AI-origin can request a draft (advisory, pending)', aiDraft.ok === true && aiDraft.draft.status === 'pending_owner' && aiDraft.draft.createdBy === 'ai');
  t.eq('AI cannot approve a draft (human-only)', (await Q.approve(aiDraft.draft.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');

  // ===== owner edits, then approves — and NOTHING is sent =====
  await Q.edit(d.draft.id, 'Hi Jane — just following up on your carpet quote!', { actor: 'owner' });
  const appr = await Q.approve(d.draft.id, { actor: 'owner' });
  t.ok('owner approval marks it ready with the edited text', appr.ok === true && appr.draft.status === 'approved' && /following up on your carpet/.test(appr.finalText));
  t.ok('approval does NOT send (no autonomous messaging)', appr.sent === false && /does not send it automatically/.test(appr.note));
  t.ok('approval is audited (APPROVE_ASSISTED_MSG)', (await GW.recentAudit(100)).some((a) => a.action === 'APPROVE_ASSISTED_MSG' && a.decision === 'allowed'));

  // ===== an empty message cannot be approved =====
  const d2 = await Q.draft({ customerId: 'c2', to: '+15552223333', intent: 'follow_up', actor: 'owner' });
  await Q.edit(d2.draft.id, '   ', { actor: 'owner' });
  t.eq('an empty message is refused at approval', (await Q.approve(d2.draft.id, { actor: 'owner' })).error, 'EMPTY_MESSAGE');

  // ===== reject is retained =====
  const rej = await Q.reject(d2.draft.id, { actor: 'owner', reason: 'not needed' });
  t.ok('a draft can be rejected + retained', rej.ok === true && (await Q.get(d2.draft.id)).status === 'rejected' && (await Q.get(d2.draft.id)).rejectionReason === 'not needed');

  // ===== model unavailable → draft still created for the owner to write =====
  await G.AAA_GOVERNED_MODEL_ROUTER.setEnabled('nvidia.nemotron4_340b_instruct', false, { actor: 'owner' });
  const du = await Q.draft({ customerId: 'c3', to: '+15554445555', intent: 'follow_up', actor: 'owner' });
  t.ok('with the model disabled, a blank draft is still created (owner writes it)', du.ok === true && du.modelUnavailable === true && du.draft.suggestedText === '');

  // ===== file(): a PRE-WRITTEN draft (e.g. remote copilot) enters the same flow =====
  const filed = await Q.file({ customerId: 'c9', channel: 'sms', body: 'Hi {{customer_name}} — checking in.', source: 'copilot', origin: 'ai' });
  t.ok('a pre-written draft is filed pending owner approval', filed.ok === true && filed.draft.status === 'pending_owner' && filed.draft.source === 'copilot' && filed.draft.createdBy === 'ai');
  t.ok('the filed body is kept verbatim with {{placeholders}}', filed.draft.suggestedText === 'Hi {{customer_name}} — checking in.' && filed.draft.finalText === null);
  t.ok('the filed draft is on the normal pending list', (await Q.pending()).some((x) => x.id === filed.draft.id));
  t.eq('an empty body cannot be filed', (await Q.file({ body: '   ' })).error, 'NO_BODY');
  t.eq('AI cannot approve a filed draft (human-only)', (await Q.approve(filed.draft.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  const filedAppr = await Q.approve(filed.draft.id, { actor: 'owner' });
  t.ok('owner approval of a filed draft marks it ready WITHOUT sending', filedAppr.ok === true && filedAppr.sent === false && filedAppr.finalText === 'Hi {{customer_name}} — checking in.');

  return t.report();
};
