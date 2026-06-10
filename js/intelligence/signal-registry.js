/*
 * AAA Signal Registry — the topology of recognized world-model signals.
 *
 * Eleven business signal types, each with its unit, default staleness policy,
 * baseline volatility, and time-to-live. The World State Ledger validates every
 * append against this registry — an unregistered signal type is a governance
 * violation, never silently accepted. Pure configuration; no behavior.
 */
;(function (global) {
  'use strict';

  // type → { unit, stalePolicy, volatility, ttlMs, description }
  const SIGNALS = {
    lead_volume: { unit: 'count', stalePolicy: 'degrade_confidence', volatility: 0.15, ttlMs: 86400000, description: 'New leads captured in the window' },
    close_rate: { unit: 'ratio', stalePolicy: 'degrade_confidence', volatility: 0.08, ttlMs: 86400000, description: 'Accepted / generated estimates' },
    quote_accuracy: { unit: 'ratio', stalePolicy: 'degrade_confidence', volatility: 0.10, ttlMs: 172800000, description: '1 − mean(|estimate − final| / final)' },
    callback_rate: { unit: 'ratio', stalePolicy: 'degrade_confidence', volatility: 0.10, ttlMs: 172800000, description: 'Jobs generating a callback' },
    crew_utilization: { unit: 'ratio', stalePolicy: 'degrade_confidence', volatility: 0.05, ttlMs: 86400000, description: 'Booked capacity / available capacity' },
    response_time: { unit: 'hours', stalePolicy: 'degrade_confidence', volatility: 0.12, ttlMs: 86400000, description: 'Lead → first response' },
    gross_margin: { unit: 'ratio', stalePolicy: 'degrade_confidence', volatility: 0.04, ttlMs: 172800000, description: '(revenue − cost) / revenue' },
    job_profitability: { unit: 'currency', stalePolicy: 'degrade_confidence', volatility: 0.06, ttlMs: 172800000, description: 'Mean profit per completed job' },
    review_velocity: { unit: 'count', stalePolicy: 'degrade_confidence', volatility: 0.20, ttlMs: 604800000, description: 'Reviews requested/received in the window' },
    marketing_cac: { unit: 'currency', stalePolicy: 'degrade_confidence', volatility: 0.15, ttlMs: 604800000, description: 'Marketing spend / new customers' },
    schedule_capacity: { unit: 'count', stalePolicy: 'degrade_confidence', volatility: 0.05, ttlMs: 86400000, description: 'Open job slots in the horizon' }
  };

  const Registry = {
    TYPES: Object.keys(SIGNALS),
    COUNT: Object.keys(SIGNALS).length,
    has(type) { return Object.prototype.hasOwnProperty.call(SIGNALS, type); },
    spec(type) { return SIGNALS[type] || null; },
    all() { return Object.keys(SIGNALS).map((k) => Object.assign({ type: k }, SIGNALS[k])); }
  };

  global.AAA_SIGNAL_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
