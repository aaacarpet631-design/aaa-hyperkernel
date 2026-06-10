/*
 * AAA Experiment Scorecard — the portfolio view of strategic experiments.
 *
 * Read model over the experiment registry: how many are running, succeeded,
 * failed; the win rate; and which are missing governance. Pure read; no
 * scoring of un-run experiments beyond status (an unfinished experiment has no
 * "result" to flatter). Deterministic.
 */
;(function (global) {
  'use strict';

  function registry() { return global.AAA_EXPERIMENT_REGISTRY; }

  const Card = {
    async portfolio() {
      if (!registry()) return { status: 'unavailable' };
      const all = await registry().list();
      const by = (s) => all.filter((e) => e.status === s).length;
      const finished = by('succeeded') + by('failed');
      return {
        total: all.length,
        proposed: by('proposed'), running: by('running'), succeeded: by('succeeded'), failed: by('failed'), aborted: by('aborted'),
        winRate: finished ? Math.round((by('succeeded') / finished) * 1000) / 1000 : null,
        winRateStatus: finished ? 'derived' : 'insufficient_data',
        governanceRequired: all.filter((e) => e.governanceRequired).length,
        running_list: all.filter((e) => e.status === 'running').map((e) => ({ id: e.experimentId, hypothesis: e.hypothesis }))
      };
    }
  };

  global.AAA_EXPERIMENT_SCORECARD = Card;
})(typeof window !== 'undefined' ? window : this);
