/*
 * AAA Adjacency Mapper — the businesses one capability-hop from where we are.
 *
 * Encodes the carpet/flooring domain's adjacency graph (shared crews, trucks,
 * customers, or sales motion) and scores each adjacency's overlap with what the
 * company already does. Overlap is structural (declared capability/customer
 * reuse); demand EVIDENCE is pulled from real data (e.g. existing commercial
 * quotes strengthen "commercial contracts"). Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  // adjacency → { overlap 0..1 (shared assets/motion), reuses, evidenceKeyword }
  const ADJACENCIES = {
    water_mitigation: { overlap: 0.8, reuses: ['crews', 'trucks', 'emergency_demand'], evidence: ['water', 'flood', 'leak'] },
    epoxy_flooring: { overlap: 0.7, reuses: ['crews', 'flooring_sales_motion'], evidence: ['epoxy', 'garage', 'concrete'] },
    commercial_contracts: { overlap: 0.75, reuses: ['crews', 'recurring_revenue', 'property_managers'], evidence: ['commercial', 'office', 'apartment', 'building'] },
    maintenance_programs: { overlap: 0.85, reuses: ['existing_customers', 'recurring_revenue'], evidence: ['maintenance', 'recurring', 'plan'] },
    recurring_services: { overlap: 0.8, reuses: ['existing_customers', 'subscription_billing'], evidence: ['subscription', 'monthly', 'membership'] }
  };

  const Mapper = {
    ADJACENCIES: Object.keys(ADJACENCIES),

    /** Map adjacencies with overlap + real demand evidence from quotes/jobs. */
    async map() {
      const quotes = await list('quotes');
      const text = quotes.map((q) => lc(JSON.stringify({ s: q.serviceType, c: q.context, n: q.notes }))).join(' ');
      return Object.keys(ADJACENCIES).map((k) => {
        const a = ADJACENCIES[k];
        const hits = a.evidence.reduce((n, kw) => n + (text.indexOf(kw) !== -1 ? 1 : 0), 0);
        return { adjacency: k, overlap: a.overlap, reuses: a.reuses, demandEvidence: hits, evidenceStatus: quotes.length ? (hits ? 'observed' : 'none_observed') : 'insufficient_data' };
      }).sort((x, y) => (y.overlap + (y.demandEvidence ? 0.1 : 0)) - (x.overlap + (x.demandEvidence ? 0.1 : 0)));
    }
  };

  global.AAA_ADJACENCY_MAPPER = Mapper;
})(typeof window !== 'undefined' ? window : this);
