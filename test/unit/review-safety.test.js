/*
 * Review-request content-safety gate — unit tests (no network).
 *
 * Verifies the fail-closed policy wired into AAA_REVIEW_REQUEST_ENGINE:
 *   safe → pending (allow) · unsafe → blocked · unknown/proxy-failure/
 *   malformed/guardrail-down → queued · templates (non-AI) pass unscreened ·
 *   screening happens regardless of aiProvider · the verdict is audit-logged.
 * The content-safety guardrail and the AI drafter are stubbed.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('review-safety');
  const { G, cfg, data } = setupEnv({ config: { businessName: 'AAA Carpet', aiProvider: 'claude', reviewUrl: 'https://g.page/r/x' } });

  // AI drafting on by default → generateMessage yields an AI draft (source:ai).
  let aiOk = true;
  G.AAA_DATA.callAgent = async () => (aiOk ? { ok: true, text: 'Hi Jane, thanks!' } : { ok: false, error: 'NO_AI' });

  // Controllable content-safety guardrail.
  let guardReady = true;
  let guardReply = { ok: true, safe: true, flagged: false, verdict: 'safe', categories: [], raw: {} };
  let calls = [];
  G.AAA_CONTENT_SAFETY = {
    isReady: () => guardReady,
    async checkResponse(user, assistant) { calls.push({ user: user, assistant: assistant }); return guardReply; }
  };

  load('js/agents/review-request-engine.js');
  const engine = G.AAA_REVIEW_REQUEST_ENGINE;
  async function seedJob(id) { await data.put('jobs', id, { id: id, customerName: 'Jane Doe', notes: 'cleaned carpets' }); }

  // 1. safe → pending / allow
  await seedJob('j_safe');
  let r = await engine.requestReview('j_safe');
  t.eq('safe → status pending', r.review.status, 'pending');
  t.eq('safe → decision allow', r.review.safety.decision, 'allow');
  t.ok('safe → no block/queue flags', r.blocked === false && r.queued === false);
  t.ok('safe → guardrail was called', calls.length === 1);

  // Claude-provider routing: screening still ran even though aiProvider=claude.
  t.eq('aiProvider is claude', cfg.flag('aiProvider'), 'claude');
  t.ok('screened under claude provider', r.review.safety.screened === true);

  // 2. unsafe → blocked
  guardReply = { ok: true, safe: false, flagged: true, verdict: 'unsafe', categories: ['S2'], raw: { 'User Safety': 'unsafe' } };
  await seedJob('j_unsafe');
  r = await engine.requestReview('j_unsafe');
  t.eq('unsafe → status blocked', r.review.status, 'blocked');
  t.ok('unsafe → blocked flag + category', r.blocked === true && r.review.safety.categories[0] === 'S2');

  // 3. unknown verdict → queued
  guardReply = { ok: true, safe: null, flagged: false, verdict: 'unknown', categories: [], raw: '???' };
  await seedJob('j_unknown');
  r = await engine.requestReview('j_unknown');
  t.eq('unknown → status queued', r.review.status, 'queued');
  t.ok('unknown → queued flag', r.queued === true);

  // 4. proxy failure (ok:false) → queued, error recorded
  guardReply = { ok: false, error: 'PROXY_NETWORK' };
  await seedJob('j_fail');
  r = await engine.requestReview('j_fail');
  t.eq('proxy failure → status queued', r.review.status, 'queued');
  t.eq('proxy failure → error recorded', r.review.safety.error, 'PROXY_NETWORK');

  // 5. malformed/unreadable reply (ok:true but safe null) → queued
  guardReply = { ok: true, safe: null, verdict: 'unknown', categories: [], raw: 'not-json' };
  await seedJob('j_malformed');
  r = await engine.requestReview('j_malformed');
  t.eq('malformed → status queued', r.review.status, 'queued');

  // 6. guardrail unavailable (fail-closed) → queued, SAFETY_UNAVAILABLE
  guardReady = false;
  await seedJob('j_noguard');
  r = await engine.requestReview('j_noguard');
  t.eq('guardrail down → status queued', r.review.status, 'queued');
  t.eq('guardrail down → error', r.review.safety.error, 'SAFETY_UNAVAILABLE');
  guardReady = true;

  // 7. template fallback (no AI) is NOT screened → pending
  aiOk = false; calls = [];
  await seedJob('j_template');
  r = await engine.requestReview('j_template');
  t.eq('template → status pending', r.review.status, 'pending');
  t.ok('template not screened', r.review.safety.screened === false && r.review.safety.source === 'template');
  t.ok('guardrail not called for template', calls.length === 0);
  aiOk = true;

  // 8. audit log carries verdict, model, and message context id
  guardReply = { ok: true, safe: false, verdict: 'unsafe', categories: ['S7'], raw: {} };
  await seedJob('j_log');
  await engine.requestReview('j_log');
  const logs = await data.list('agent_logs');
  const logged = logs.find((l) => l.context && l.context.jobId === 'j_log');
  t.ok('log has verdict', !!logged && logged.context.verdict === 'unsafe');
  t.ok('log has model', !!logged && logged.context.model === 'nvidia/nemotron-3-content-safety');
  t.ok('log message-context id matches review id', !!logged && logged.context.messageContextId === logged.context.reviewId);

  return t.report();
};
