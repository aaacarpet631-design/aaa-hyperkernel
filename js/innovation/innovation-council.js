/*
 * AAA Innovation Council — discover, simulate, and validate new ways to grow.
 *
 * Composes Venture Discovery, Business Model Simulation, Technology Scouting,
 * Automation Discovery, and Strategic Experiments. Like the Revenue Council, it
 * is read-only over the business and routes every recommendation through
 * AAA_COUNCIL_GOVERNANCE (emitting innovation.recommendation_proposed →
 * HUMAN_APPROVAL_REQUIRED). Business-model tests run through the Simulation
 * Council; nothing reaches production without approval.
 */
;(function (global) {
  'use strict';

  const G = (k) => global[k];

  const Council = {
    /** Discover adjacent ventures and register the top ones. */
    async discoverVentures(opts) { return G('AAA_VENTURE_DISCOVERY_ENGINE') ? G('AAA_VENTURE_DISCOVERY_ENGINE').discoverAndRegister(opts) : { status: 'unavailable' }; },

    /** Simulate a business model through the Simulation Council. */
    async simulateModel(model, opts) { return G('AAA_BUSINESS_MODEL_SIMULATOR') ? G('AAA_BUSINESS_MODEL_SIMULATOR').simulate(model, opts) : { ok: false, error: 'unavailable' }; },

    /** Score tracked technologies. */
    async scoutTechnology() { return G('AAA_TECHNOLOGY_SCOUT_ENGINE') ? G('AAA_TECHNOLOGY_SCOUT_ENGINE').scoreAll() : []; },

    /** Find automation candidates from human tasks. */
    discoverAutomation(tasks) { return G('AAA_AUTOMATION_DISCOVERY_ENGINE') ? G('AAA_AUTOMATION_DISCOVERY_ENGINE').discover(tasks) : []; },

    /** Register a strategic experiment (rollback plan enforced by the registry). */
    async createExperiment(exp) { return G('AAA_EXPERIMENT_REGISTRY') ? G('AAA_EXPERIMENT_REGISTRY').create(exp) : { ok: false, error: 'unavailable' }; },

    /**
     * Validate a discovered opportunity by simulating its business model, then
     * proposing it into governance. Moves the opportunity to 'simulating' and
     * attaches the immutable sim runId. Nothing is applied without approval.
     */
    async validateOpportunity(opportunityId, model, opts) {
      const reg = G('AAA_OPPORTUNITY_REGISTRY');
      if (!reg) return { ok: false, error: 'REGISTRY_UNAVAILABLE' };
      const opp = await reg.get(opportunityId);
      if (!opp) return { ok: false, error: 'OPPORTUNITY_NOT_FOUND' };
      const sim = await this.simulateModel(model, opts);
      if (sim && sim.ok && sim.simulation) await reg.setStatus(opportunityId, 'simulating', { simRunId: sim.simulation.runId });
      const prop = await this.propose({ action: 'launch ' + opp.opportunity + ' via ' + model, rationale: 'Simulated projected annual margin $' + (sim.projection ? sim.projection.projectedAnnualMargin : 'n/a'), simRunId: sim && sim.simulation ? sim.simulation.runId : null, expected: sim && sim.projection ? sim.projection : null, confidence: sim ? sim.confidence : null });
      return { ok: true, opportunity: opp, simulation: sim, proposal: prop.recommendation };
    },

    /** Propose an innovation recommendation INTO governance (only mutation path). */
    async propose(rec) {
      const gov = G('AAA_COUNCIL_GOVERNANCE');
      if (!gov) return { ok: false, error: 'GOVERNANCE_UNAVAILABLE' };
      return gov.propose('innovation', Object.assign({ council: 'innovation' }, rec || {}));
    }
  };

  global.AAA_INNOVATION_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
