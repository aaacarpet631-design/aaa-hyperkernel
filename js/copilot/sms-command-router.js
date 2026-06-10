/*
 * AAA SMS Command Router — owner-only gateway from a text message to the
 * Executive Copilot.
 *
 * Authenticates by approved phone number (config-driven; fail-closed — an
 * unknown number is rejected and never routed) and forwards an authorized
 * message through the SAME Executive Copilot intent router/governance used by
 * the app. SMS therefore inherits every governance guarantee for free: it can
 * never perform a protected action, only surface an approval request.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function copilot() { return global.AAA_EXECUTIVE_COPILOT; }

  // Normalize to comparable digits (last 10 — country-code tolerant).
  function normalize(phone) { const d = String(phone == null ? '' : phone).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }

  const Router = {
    normalize: normalize,

    /** Approved owner phone numbers from config (array). */
    approvedPhones() {
      const list = (cfg().flag ? cfg().flag('ownerPhones', null) : null) || cfg().ownerPhones || [];
      return (Array.isArray(list) ? list : []).map(normalize).filter(Boolean);
    },

    isApproved(phone) { const n = normalize(phone); return !!n && this.approvedPhones().indexOf(n) !== -1; },

    /**
     * Route an inbound message. Unauthorized → { authorized:false }. Authorized
     * → { authorized:true, answer } where answer is the Copilot's governed reply.
     */
    async route(inbound) {
      const m = inbound || {};
      if (!this.isApproved(m.from)) return { authorized: false, reason: 'UNKNOWN_NUMBER' };
      if (!copilot()) return { authorized: true, answer: { ok: false, error: 'COPILOT_UNAVAILABLE' } };
      const answer = await copilot().ask(String(m.body || ''), m.opts || {});
      return { authorized: true, answer: answer };
    }
  };

  global.AAA_SMS_COMMAND_ROUTER = Router;
})(typeof window !== 'undefined' ? window : this);
