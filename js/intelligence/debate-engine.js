/*
 * AAA Debate Engine — the adversarial core (Layers 3 & 4).
 *
 * A recommendation is never accepted because it sounds good. It must survive:
 *
 *     Recommendation  →  Critic  →  Risk  →  Supervisor verdict
 *
 * The recommendation analyst proposes (grounded in real data). The Critic finds
 * its strongest weakness and challenges its assumptions. The Risk analyst surfaces
 * what could go wrong and can mark it blocking. The Supervisor arbitrates with a
 * CALIBRATED confidence — reflecting evidence and unresolved objections, not how
 * many agents agreed. The full transcript and verdict are written to shared
 * memory (`debates`) so outcomes can later prove the debate right or wrong.
 *
 * Honest by construction: gated on the proxy; if any stage cannot run, the debate
 * reports exactly how far it got instead of inventing a verdict.
 */
;(function (global) {
  'use strict';

  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); }
  function now() { return clock() ? clock().now() : Date.now(); }

  const Debate = {
    isReady: function () { return !!(div() && div().isReady()); },

    /**
     * Run a full debate over a recommendation.
     * @param {object} args
     *   - topic: string (what is being decided)
     *   - context: object (the real data / situation — embedded as JSON)
     *   - recommendation: optional pre-formed recommendation {recommendation, rationale, confidence}.
     *       If omitted, `proposer` (a role) produces one first.
     *   - proposer: optional role {id, model, system}; defaults to a generic analyst.
     *   - meta: optional {teamId, jobId, source} stored on the record.
     * @returns {Promise<object>} { ok, debateId, verdict, accepted, confidence, transcript, ... }
     */
    async run(args) {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      args = args || {};
      const topic = String(args.topic || 'Assess this recommendation.');
      const context = args.context || {};
      const meta = args.meta || {};
      const ctxJson = JSON.stringify(context, null, 2);
      const transcript = [];

      // --- Stage 1: recommendation ---------------------------------------
      let rec = args.recommendation || null;
      if (!rec) {
        const proposer = args.proposer || { id: 'recommendation', model: D.WORKER,
          system: 'You are a Recommendation Analyst for ' + D.COMPANY + '\nPropose the single best action for the topic, grounded ONLY in the JSON data. Respond ONLY as JSON matching the schema.' };
        const r = await D.runRole(proposer,
          'TOPIC:\n' + topic + '\n\nDATA (JSON):\n' + ctxJson + '\n\nPropose your analysis and recommendation as JSON.',
          D.ANALYSIS_SCHEMA, { agent: 'recommendation', maxTokens: 900 });
        if (!r.ok) return { ok: false, error: r.error, stage: 'recommendation', raw: r.raw };
        rec = { recommendation: r.data.recommendation, rationale: r.data.summary, confidence: r.data.confidence, analysis: r.data };
      }
      transcript.push({ role: 'recommendation', output: rec });

      const recJson = JSON.stringify({ recommendation: rec.recommendation, rationale: rec.rationale, confidence: rec.confidence }, null, 2);

      // --- Stage 2 & 3: critic + risk (independent, parallel) ------------
      const criticPrompt = 'TOPIC:\n' + topic + '\n\nRECOMMENDATION (JSON):\n' + recJson +
        '\n\nREAL DATA BEHIND IT (JSON):\n' + ctxJson + '\n\nChallenge it. Respond ONLY as JSON matching the schema.';
      const riskPrompt = 'TOPIC:\n' + topic + '\n\nRECOMMENDATION (JSON):\n' + recJson +
        '\n\nREAL DATA (JSON):\n' + ctxJson + '\n\nAssess the risks. Respond ONLY as JSON matching the schema.';

      const [criticR, riskR] = await Promise.all([
        D.runRole(D.DEBATE.critic, criticPrompt, D.CRITIC_SCHEMA, { agent: 'critic' }),
        D.runRole(D.DEBATE.risk, riskPrompt, D.RISK_SCHEMA, { agent: 'risk' })
      ]);
      if (criticR.ok) transcript.push({ role: 'critic', output: criticR.data });
      if (riskR.ok) transcript.push({ role: 'risk', output: riskR.data });
      // The debate can still conclude if one challenger fails, but not if both do.
      if (!criticR.ok && !riskR.ok) {
        return { ok: false, error: 'CHALLENGERS_FAILED', detail: [criticR.error, riskR.error], transcript: transcript };
      }

      // --- Stage 4: supervisor verdict -----------------------------------
      const verdictPrompt = 'TOPIC:\n' + topic +
        '\n\nRECOMMENDATION (JSON):\n' + recJson +
        '\n\nCRITIC (JSON):\n' + JSON.stringify(criticR.ok ? criticR.data : { unavailable: true }, null, 2) +
        '\n\nRISK (JSON):\n' + JSON.stringify(riskR.ok ? riskR.data : { unavailable: true }, null, 2) +
        '\n\nREAL DATA (JSON):\n' + ctxJson +
        '\n\nArbitrate. Set a calibrated confidence reflecting evidence strength AND unresolved objections. Respond ONLY as JSON matching the schema.';
      const verdictR = await D.runRole(D.DEBATE.supervisor, verdictPrompt, D.VERDICT_SCHEMA, { agent: 'review_supervisor', maxTokens: 800 });
      if (!verdictR.ok) return { ok: false, error: verdictR.error, stage: 'verdict', transcript: transcript, raw: verdictR.raw };
      transcript.push({ role: 'supervisor', output: verdictR.data });

      const v = verdictR.data;
      const blocked = !!(riskR.ok && riskR.data.blocking);
      // A blocking risk caps a bare "accept" down to "revise" — the field can't ship a blocked action as-is.
      const verdict = (blocked && v.verdict === 'accept') ? 'revise' : v.verdict;
      const accepted = verdict === 'accept';

      const record = {
        id: newId('debate'),
        topic: topic,
        teamId: meta.teamId || null,
        jobId: meta.jobId || null,
        source: meta.source || 'manual',
        recommendation: rec.recommendation,
        proposedConfidence: rec.confidence != null ? rec.confidence : null,
        verdict: verdict,
        accepted: accepted,
        calibratedConfidence: typeof v.calibrated_confidence === 'number' ? v.calibrated_confidence : null,
        finalRecommendation: v.final_recommendation || rec.recommendation,
        conditions: Array.isArray(v.conditions) ? v.conditions : [],
        blocking: blocked,
        transcript: transcript,
        createdAt: now()
      };

      // --- Layer 6: persist + log a scorable decision for the supervisor --
      try { await data().put('debates', record.id, record); } catch (_) {}
      try {
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('debates', record.id, record);
      } catch (_) {}
      // Log the arbitrated decision so the existing Supervisor scores it on outcomes.
      let decisionId = null;
      try {
        const logged = await data().logDecision({
          agent: meta.teamId ? ('team_' + meta.teamId) : 'debate',
          jobId: record.jobId,
          decision: record.finalRecommendation,
          rationale: v.rationale || '',
          confidence: record.calibratedConfidence,
          inputs: { topic: topic, verdict: verdict, source: record.source },
          debateId: record.id
        });
        decisionId = logged && logged.id;
        record.decisionId = decisionId;
        await data().put('debates', record.id, record);
      } catch (_) {}
      try { if (data().logAgent) data().logAgent('debate', verdict.toUpperCase() + ': ' + topic.slice(0, 80), { debateId: record.id, confidence: record.calibratedConfidence }); } catch (_) {}

      return {
        ok: true, debateId: record.id, decisionId: decisionId,
        verdict: verdict, accepted: accepted, blocking: blocked,
        confidence: record.calibratedConfidence,
        finalRecommendation: record.finalRecommendation,
        conditions: record.conditions, transcript: transcript
      };
    },

    async list() { return data() ? (await data().list('debates')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; },
    async get(id) { return data() ? data().get('debates', id) : null; }
  };

  global.AAA_DEBATE = Debate;
})(typeof window !== 'undefined' ? window : this);
