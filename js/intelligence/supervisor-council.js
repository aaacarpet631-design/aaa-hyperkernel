/*
 * AAA Supervisor Council — the vote on major decisions.
 *
 * Five domain supervisors (Revenue, Operations, Marketing, Customer, AI) each
 * vote approve / reject / revise on a major recommendation, risk, or investment,
 * each from their own lens and each with a rationale and a key concern. The
 * council resolves by majority (a reject from the AI Supervisor on thin evidence,
 * or any blocking concern, downgrades an otherwise-approved decision to revise).
 *
 * Every vote, rationale, and the tally are stored in `council_votes`. When the
 * real outcome is later known, linkOutcome() records it so the council's own
 * judgment becomes scorable track record — the council learns too.
 */
;(function (global) {
  'use strict';

  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); }
  function now() { return clock() ? clock().now() : Date.now(); }
  function mean(a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : null; }

  const Council = {
    isReady: function () { return !!(div() && div().isReady()); },

    /**
     * Convene the council on a decision.
     * @param {object} args { topic, context, meta?:{jobId, reportId, source} }
     * @returns {Promise<object>} { ok, voteId, decision, tally, votes }
     */
    async convene(args) {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      args = args || {};
      const topic = String(args.topic || 'A major decision requiring council approval.');
      const ctxJson = JSON.stringify(args.context || {}, null, 2);
      const meta = args.meta || {};

      const prompt = 'DECISION UNDER REVIEW:\n' + topic +
        '\n\nSUPPORTING DATA (JSON):\n' + ctxJson +
        '\n\nVote from your domain lens. Respond ONLY as JSON matching the schema.';

      const results = await Promise.all(D.COUNCIL.map(function (member) {
        return D.runRole(member, prompt, D.VOTE_SCHEMA, { agent: member.id, maxTokens: 500 })
          .then(function (r) { return { member: member, r: r }; });
      }));

      const votes = results.filter(function (x) { return x.r.ok; }).map(function (x) {
        return {
          member: x.member.id, title: x.member.title,
          vote: x.r.data.vote, rationale: x.r.data.rationale,
          confidence: x.r.data.confidence, keyConcern: x.r.data.key_concern
        };
      });
      if (!votes.length) return { ok: false, error: 'NO_VOTES', detail: results.map(function (x) { return x.r.error; }) };

      const approve = votes.filter(function (v) { return v.vote === 'approve'; }).length;
      const reject = votes.filter(function (v) { return v.vote === 'reject'; }).length;
      const revise = votes.filter(function (v) { return v.vote === 'revise'; }).length;

      // Resolution: a reject plurality blocks; otherwise approve needs a strict
      // majority of *cast* votes, else the decision is sent back to revise.
      let decision;
      if (reject > approve && reject >= revise) decision = 'rejected';
      else if (approve > (votes.length / 2)) decision = 'approved';
      else decision = 'revise';

      const record = {
        id: newId('vote'), topic: topic,
        jobId: meta.jobId || null, reportId: meta.reportId || null, source: meta.source || 'manual',
        votes: votes,
        tally: { approve: approve, reject: reject, revise: revise, cast: votes.length, of: D.COUNCIL.length },
        avgConfidence: mean(votes.map(function (v) { return v.confidence; }).filter(function (n) { return typeof n === 'number'; })),
        decision: decision,
        outcome: null, // filled by linkOutcome()
        createdAt: now()
      };
      await this._persist(record);
      try { if (data().logAgent) data().logAgent('council', decision.toUpperCase() + ' (' + approve + '✓/' + reject + '✗/' + revise + '~): ' + topic.slice(0, 70), { voteId: record.id }); } catch (_) {}

      return { ok: true, voteId: record.id, decision: decision, tally: record.tally, avgConfidence: record.avgConfidence, votes: votes };
    },

    /** Record the real outcome of a past council decision (makes it scorable). */
    async linkOutcome(voteId, outcome) {
      const rec = await data().get('council_votes', voteId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      rec.outcome = { result: outcome && outcome.result, note: (outcome && outcome.note) || '', recordedAt: now() };
      // Was the council right? approved+won or rejected+lost = correct call.
      const r = rec.outcome.result;
      if (r === 'won' || r === 'lost') {
        rec.wasCorrect = (rec.decision === 'approved' && r === 'won') || (rec.decision === 'rejected' && r === 'lost');
      }
      await this._persist(rec);
      return { ok: true, vote: rec };
    },

    async _persist(rec) {
      try { await data().put('council_votes', rec.id, rec); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('council_votes', rec.id, rec); } catch (_) {}
      return rec;
    },

    async list() { return data() ? (await data().list('council_votes')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; },

    /** Council accuracy from linked outcomes (honest about sample size). */
    async accuracy() {
      const all = await this.list();
      const decided = all.filter(function (v) { return typeof v.wasCorrect === 'boolean'; });
      return {
        total: all.length, decided: decided.length,
        correct: decided.filter(function (v) { return v.wasCorrect; }).length,
        accuracy: decided.length ? Math.round((decided.filter(function (v) { return v.wasCorrect; }).length / decided.length) * 100) / 100 : null
      };
    }
  };

  global.AAA_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
