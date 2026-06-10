/*
 * AAA Capability Gap Detector — recognizes that nobody on staff can handle an
 * event, and says so out loud.
 *
 * Subscribes to typed Event Bus events and derives the NEED each one implies
 * using the spawning formula: Action + Entity + Context (+ domain hint). It
 * then asks the Capability Registry whether a registered agent can handle the
 * need. A hit returns the permanent handler (no spawn — permanent employees
 * first). A miss is a CAPABILITY GAP: persisted to `capability_gaps` and
 * handed to the Genesis Council.
 *
 * Deriving rules are declarative and additive (TRIGGERS); unknown events
 * produce no gap rather than a guessed one — honest by construction.
 */
;(function (global) {
  'use strict';

  const GAPS = 'capability_gaps';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function bus() { return global.AAA_EVENT_BUS; }
  function registry() { return global.AAA_CAPABILITY_REGISTRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function slug(v) { return String(v == null ? '' : v).toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // ---- declarative trigger → need rules --------------------------------------
  // Each rule derives {action, entity, context, domain} from a typed event.
  // context may come from the payload (e.g. damage tags on a photo).
  const TRIGGERS = {
    'photo.uploaded': function (p) {
      const tags = Array.isArray(p && p.tags) ? p.tags.map(slug).filter(Boolean) : [];
      return { action: 'detect', entity: 'damage', context: tags.join(' ') || 'general', domain: 'vision' };
    },
    'invoice.issued': function (p) {
      const amt = Number(p && p.amount);
      if (isFinite(amt) && amt > 10000) return { action: 'verify', entity: 'invoice', context: 'over 10000', domain: 'finance' };
      return null; // routine invoices are handled by the permanent finance flow
    },
    'review.received': function (p) {
      const lang = p && p.language ? slug(p.language) : null;
      return lang && lang !== 'english' ? { action: 'translate', entity: 'review', context: lang, domain: 'language' } : null;
    }
  };

  const Detector = {
    GAPS: GAPS,
    TRIGGERS: Object.keys(TRIGGERS),

    /** Derive the need an event implies, or null when no rule matches. */
    deriveNeed(eventType, payload) {
      const rule = TRIGGERS[eventType];
      if (!rule) return null;
      const need = rule(payload || {});
      return need ? Object.assign({ triggerEvent: eventType }, need) : null;
    },

    /** Register/replace a trigger rule (additive seam for new domains). */
    defineTrigger(eventType, fn) {
      if (typeof fn !== 'function') return { ok: false, error: 'RULE_REQUIRED' };
      TRIGGERS[eventType] = fn;
      return { ok: true };
    },

    /**
     * Inspect one event: derive the need, check the registry.
     * → { handled:true, handler }            a permanent agent covers it
     * → { handled:false, gap }               nobody can — gap recorded
     * → { handled:false, need:null }         event implies no agent work
     */
    async inspect(eventType, payload) {
      const need = this.deriveNeed(eventType, payload);
      if (!need) return { handled: false, need: null };
      const reg = registry();
      const handler = reg ? await reg.canHandle(need.action, need.entity, need.context) : null;
      if (handler) return { handled: true, need: need, handler: handler };
      const id = ids() ? ids().createId('gap') : 'gap_' + Date.now();
      const gap = {
        id: id, workspaceId: ws(), triggerEvent: eventType,
        action: need.action, entity: need.entity, context: need.context, domain: need.domain || null,
        payload: payload || {}, status: 'open', detectedAt: nowISO()
      };
      await data().put(GAPS, id, gap);
      return { handled: false, need: need, gap: gap };
    },

    /** Open gaps (newest first). */
    async gaps() {
      const all = (await data().list(GAPS)).filter(mine);
      return all.sort((a, b) => String(b.detectedAt || '').localeCompare(String(a.detectedAt || '')));
    },

    /**
     * Wire the detector to the Event Bus: every trigger event flows into the
     * Genesis Council automatically. Idempotent; safe without a bus (tests).
     */
    install() {
      if (this._installed || !bus()) return { ok: !!bus(), wired: 0 };
      let wired = 0;
      Object.keys(TRIGGERS).forEach((type) => {
        bus().subscribe(type, (payload) => {
          const council = global.AAA_GENESIS_COUNCIL;
          if (council) council.handleEvent(type, payload).catch(function () {});
        });
        wired++;
      });
      this._installed = true;
      return { ok: true, wired: wired };
    }
  };

  global.AAA_GAP_DETECTOR = Detector;
})(typeof window !== 'undefined' ? window : this);
