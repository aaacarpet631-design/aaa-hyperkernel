/*
 * AAA Supervisor — outcome learning + scoring.
 *
 * Closes the loop: when an outcome is recorded, it links the related agent
 * decisions to that outcome and scores them (confidence calibration via a
 * Brier-style score; estimate accuracy vs. the final amount). It computes
 * real team metrics from shared memory and writes scores back so future
 * recommendations can be weighted by track record.
 *
 * All math runs over real data in shared memory. With too little data it
 * honestly reports `status: 'warming_up'` rather than inventing numbers.
 */
;(function (global) {
  'use strict';

  const MIN_FOR_METRICS = 3; // below this, we report "warming up"

  function data() { return global.AAA_DATA; }
  function sb() { return global.AAA_SUPABASE; }
  function cfg() { return global.AAA_CONFIG; }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
  function round(n, p) { const f = Math.pow(10, p || 2); return Math.round(n * f) / f; }

  /** Parse a quote range like "$200-$400" / "$200–$400" / "$250" → midpoint number. */
  function quoteMidpoint(range) {
    if (range == null) return null;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const vals = nums.map(Number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  async function persistDecision(dec) {
    await data().put('agent_decisions', dec.id, dec);
    // Best-effort cloud sync of the new score + outcome link.
    try {
      if (data().cloudReady && data().cloudReady() && sb()) {
        await sb().upsert('agent_decisions', [{
          workspace_id: cfg().workspaceId, client_id: dec.id,
          agent: dec.agent || 'unknown', decision: dec.decision || '',
          confidence: dec.confidence != null ? dec.confidence : null,
          score: dec.score != null ? dec.score : null
        }], 'workspace_id,client_id');
      }
    } catch (_) {}
  }

  const Supervisor = {
    /**
     * Score every decision tied to this outcome's job. Returns a summary.
     * @param {object} outcome  { id, jobId, result, finalAmount? }
     */
    async scoreOutcome(outcome) {
      if (!data() || !outcome || !outcome.jobId) return { ok: false, error: 'INVALID_OUTCOME' };
      const actual = outcome.result === 'won' ? 1 : outcome.result === 'lost' ? 0 : null;

      const decisions = await data().list('agent_decisions');
      const related = decisions.filter((d) => d && d.jobId === outcome.jobId);

      let scored = 0;
      for (const dec of related) {
        if (actual == null || dec.confidence == null || dec.score != null) continue;
        const p = dec.confidence / 100;
        const brier = (p - actual) * (p - actual);   // 0 best … 1 worst
        dec.score = round(1 - brier, 3);              // 1 best … 0 worst (calibration)
        dec.outcomeId = outcome.id;
        await persistDecision(dec);
        scored++;
      }

      // Estimate accuracy: compare the job's estimate(s) to the final amount.
      let estimateAccuracy = null;
      if (typeof outcome.finalAmount === 'number' && outcome.finalAmount > 0) {
        const job = await data().get('jobs', outcome.jobId);
        const ests = job && Array.isArray(job.estimates) ? job.estimates : [];
        const mids = ests.map((e) => quoteMidpoint(e.estimatedQuoteRange)).filter((n) => n != null);
        if (mids.length) {
          const predicted = mean(mids);
          estimateAccuracy = round(Math.max(0, 1 - Math.abs(predicted - outcome.finalAmount) / outcome.finalAmount), 3);
          // stash on the outcome so metrics() can aggregate it
          try { await data().put('outcomes', outcome.id, Object.assign({}, outcome, { estimateAccuracy: estimateAccuracy })); } catch (_) {}
        }
      }

      return { ok: true, scoredDecisions: scored, estimateAccuracy: estimateAccuracy };
    },

    /** Real team performance metrics from shared memory. Honest about sample size. */
    async metrics() {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const outcomes = await data().list('outcomes');
      const decisions = await data().list('agent_decisions');

      const wonLost = outcomes.filter((o) => o.result === 'won' || o.result === 'lost');
      const won = wonLost.filter((o) => o.result === 'won').length;
      const scored = decisions.filter((d) => typeof d.score === 'number');
      const estAcc = outcomes.map((o) => o.estimateAccuracy).filter((n) => typeof n === 'number');

      // Per-agent track record.
      const perAgent = {};
      decisions.forEach((d) => {
        const a = d.agent || 'unknown';
        const p = perAgent[a] || (perAgent[a] = { decisions: 0, confidences: [], scores: [] });
        p.decisions++;
        if (d.confidence != null) p.confidences.push(d.confidence);
        if (typeof d.score === 'number') p.scores.push(d.score);
      });
      Object.keys(perAgent).forEach((a) => {
        const p = perAgent[a];
        p.avgConfidence = p.confidences.length ? round(mean(p.confidences), 1) : null;
        p.avgScore = p.scores.length ? round(mean(p.scores), 3) : null;
        p.scoredCount = p.scores.length;
        delete p.confidences; delete p.scores;
      });

      const enough = outcomes.length >= MIN_FOR_METRICS;
      return {
        ok: true,
        status: enough ? 'ok' : 'warming_up',
        sample: { outcomes: outcomes.length, decisions: decisions.length, scoredDecisions: scored.length },
        closeRate: wonLost.length ? round(won / wonLost.length, 3) : null,
        avgCalibration: scored.length ? round(mean(scored.map((d) => d.score)), 3) : null,
        avgEstimateAccuracy: estAcc.length ? round(mean(estAcc), 3) : null,
        perAgent: perAgent
      };
    }
  };

  global.AAA_SUPERVISOR = Supervisor;
})(typeof window !== 'undefined' ? window : this);
