/*
 * AAA Copilot Council Query Engine — read-only fan-out to the councils.
 *
 * Pulls the existing read models (Revenue, Innovation, Simulation/Strategy,
 * Teleological/World Model, Capability Economy, Knowledge Compounding,
 * Governance ledger) and returns them in one bundle. Every source that has no
 * data returns `{ status: 'insufficient_data' }` — never a fabricated number.
 * Strictly read-only; it never proposes, mutates, or approves.
 */
;(function (global) {
  'use strict';

  const G = function (k) { return global[k]; };
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  async function safe(fn) { try { const r = await fn(); return r == null ? { status: 'insufficient_data' } : r; } catch (_) { return { status: 'unavailable' }; } }

  const Engine = {
    /** Query a set of councils/data keys (or all when omitted). → bundle. */
    async query(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const want = Array.isArray(o.councils) ? o.councils : ['revenue', 'innovation', 'simulation', 'teleological', 'capability', 'knowledge', 'governance'];
      const bundle = {};

      if (want.indexOf('revenue') !== -1) bundle.revenue = G('AAA_REVENUE_DASHBOARD') ? await safe(function () { return G('AAA_REVENUE_DASHBOARD').view({ now: now }); }) : { status: 'unavailable' };
      if (want.indexOf('innovation') !== -1) bundle.innovation = G('AAA_INNOVATION_DASHBOARD') ? await safe(function () { return G('AAA_INNOVATION_DASHBOARD').view({}); }) : { status: 'unavailable' };
      if (want.indexOf('simulation') !== -1) bundle.simulation = G('AAA_STRATEGY_SCORECARD') ? await safe(function () { return G('AAA_STRATEGY_SCORECARD').dashboard({}); }) : { status: 'unavailable' };
      if (want.indexOf('teleological') !== -1) bundle.teleological = G('AAA_TELEOLOGICAL_GOAL_ENGINE') ? await safe(function () { return G('AAA_TELEOLOGICAL_GOAL_ENGINE').currentVector(now); }) : { status: 'unavailable' };
      if (want.indexOf('capability') !== -1) bundle.capability = G('AAA_CAPABILITY_DASHBOARD') ? await safe(function () { return G('AAA_CAPABILITY_DASHBOARD').view({}); }) : { status: 'unavailable' };
      if (want.indexOf('knowledge') !== -1) bundle.knowledge = G('AAA_KNOWLEDGE_COMPOUNDING_ENGINE') ? await safe(function () { return G('AAA_KNOWLEDGE_COMPOUNDING_ENGINE').assess(); }) : { status: 'unavailable' };
      if (want.indexOf('world') !== -1) bundle.world = G('AAA_WORLD_MODEL') ? await safe(function () { return G('AAA_WORLD_MODEL').snapshot({ now: now }); }) : { status: 'unavailable' };
      if (want.indexOf('governance') !== -1) bundle.governance = G('AAA_COUNCIL_GOVERNANCE') ? await safe(function () { return G('AAA_COUNCIL_GOVERNANCE').list({}); }) : { status: 'unavailable' };
      if (want.indexOf('bottlenecks') !== -1) bundle.bottlenecks = G('AAA_SCIENTIFIC_DISCOVERY_COUNCIL') ? await safe(function () { return G('AAA_SCIENTIFIC_DISCOVERY_COUNCIL').identifyBottleneck(now); }) : { status: 'unavailable' };

      return bundle;
    }
  };

  global.AAA_COPILOT_COUNCIL_QUERY = Engine;
})(typeof window !== 'undefined' ? window : this);
