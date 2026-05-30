/*
 * AAA Marketing Intelligence.
 *
 * Computes REAL channel performance from shared memory — customers grouped by
 * lead source, jobs, and win/loss outcomes per source → close rate by channel.
 * The Marketing agent then reasons over those real numbers to recommend where
 * to focus spend. No Google Ads API calls are faked; live Ads integration
 * (OAuth + developer token) is a documented future step.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }

  const Marketing = {
    /** Real per-source rollup: { source, customers, jobs, won, lost, closeRate }[]. */
    async channelStats() {
      if (!data()) return [];
      const customers = await data().listCustomers();
      const jobs = await data().listJobs();
      const outcomes = await data().list('outcomes');

      const custSource = {};
      customers.forEach((c) => { custSource[c.id] = (c.source || 'unknown'); });
      const jobSource = {};
      jobs.forEach((j) => { jobSource[j.id] = j.source || custSource[j.customerId] || 'unknown'; });

      const stats = {};
      const bucket = (s) => (stats[s] || (stats[s] = { source: s, customers: 0, jobs: 0, won: 0, lost: 0 }));
      customers.forEach((c) => bucket(c.source || 'unknown').customers++);
      jobs.forEach((j) => bucket(jobSource[j.id]).jobs++);
      outcomes.forEach((o) => {
        const b = bucket(jobSource[o.jobId] || 'unknown');
        if (o.result === 'won') b.won++; else if (o.result === 'lost') b.lost++;
      });

      return Object.values(stats).map((b) => {
        const wl = b.won + b.lost;
        b.closeRate = wl ? Math.round((b.won / wl) * 100) / 100 : null;
        return b;
      }).sort((a, b) => b.jobs - a.jobs);
    },

    /** Run the Marketing agent over the real channel stats. */
    async review() {
      const os = global.AAA_AGENT_OS;
      if (!os || !os.isReady || !os.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      const channels = await this.channelStats();
      return os.runAgent('marketing',
        'Using these real channel results, recommend where to focus marketing spend and how to attract more profitable jobs. Call out the best and worst channels by close rate and volume.',
        { channels: channels });
    }
  };

  global.AAA_MARKETING = Marketing;
})(typeof window !== 'undefined' ? window : this);
