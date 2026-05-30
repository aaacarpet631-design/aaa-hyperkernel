/*
 * AAA Automation — event-driven agent activation ("auto-pilot").
 *
 * Subscribes to domain events and runs the relevant agent/meeting in the
 * background, logging decisions to shared memory. OFF by default and gated on
 * both the flag AND a configured proxy, so it never spends tokens or acts
 * unexpectedly. When off/unconfigured it is a complete no-op (no fabrication).
 *
 *   job.created    → Sales + Operations intake meeting
 *   estimate.added → Accounting margin/pricing review
 *   job.closed     → Customer Success follow-up recommendation
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG; }
  function os() { return global.AAA_AGENT_OS; }
  function data() { return global.AAA_DATA; }

  const Automation = {
    _bound: false,

    /** Is auto-pilot turned on? (persisted in config) */
    enabled() { return !!(cfg() && cfg().autoAgents); },

    /** Will events actually trigger agents right now? */
    active() { return !!(this.enabled() && os() && os().isReady && os().isReady()); },

    /** Toggle auto-pilot on/off (persisted). */
    setEnabled(on) {
      if (cfg() && cfg().set) cfg().set({ autoAgents: !!on });
      return this.enabled();
    },

    /** Register event listeners once. Safe to call on every boot. */
    init() {
      if (this._bound || !global.AAA_EVENTS) return;
      this._bound = true;
      global.AAA_EVENTS.on('job.created', (p) => this._onJobCreated(p));
      global.AAA_EVENTS.on('estimate.added', (p) => this._onEstimate(p));
      global.AAA_EVENTS.on('job.closed', (p) => this._onClosed(p));
    },

    async _job(jobId) { return data() ? data().get('jobs', jobId) : null; },
    _ctx(job) {
      return {
        jobId: job.id, customerName: job.customerName, state: job.currentState,
        serviceAddress: job.serviceAddress, scheduledDate: job.scheduledDate,
        notes: job.notes, estimates: Array.isArray(job.estimates) ? job.estimates : []
      };
    },

    async _onJobCreated(p) {
      if (!this.active() || !p || !p.jobId) return;
      const job = await this._job(p.jobId);
      if (job) await os().runMeeting('New job intake: qualify the lead and plan the first steps.', this._ctx(job), ['sales', 'operations']);
    },
    async _onEstimate(p) {
      if (!this.active() || !p || !p.jobId) return;
      const job = await this._job(p.jobId);
      if (job) await os().runAgent('accounting', 'Review this estimate for margin, pricing floor, and profitability risk.', this._ctx(job));
    },
    async _onClosed(p) {
      if (!this.active() || !p || !p.jobId) return;
      const job = await this._job(p.jobId);
      if (job) await os().runAgent('customer_success', 'The job just closed. Recommend follow-up and review-request actions to drive retention and repeat business.', this._ctx(job));
    }
  };

  global.AAA_AUTOMATION = Automation;
})(typeof window !== 'undefined' ? window : this);
