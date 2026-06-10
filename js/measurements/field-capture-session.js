/*
 * AAA Field Capture Session — START MEASUREMENT, capture rooms, get a quote
 * draft, without a keyboard or a job.
 *
 * The job-optional multi-room session the Field Mode home opens. A tech captures
 * Room 1, Room 2, Room 3 (photo / laser / voice → measurement sessions, reusing
 * AAA_MEASUREMENT_STORE + MODELS), and the Field Brain + AAA_MEASUREMENT_QUOTE
 * aggregate them into ONE quote draft: total sqft, 12-ft material plan, waste,
 * stairs, labor, and a priced range. It can be attached to an existing job or
 * left standalone. Nothing finalizes a price (the quote always needsReview), and
 * it mutates no job's business record — it links field data and produces a draft.
 *
 * Honest by construction: with no rooms it returns insufficient_data; with no
 * pricing engine it returns the physical aggregate and says so.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'field_capture_sessions';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function store() { return global.AAA_MEASUREMENT_STORE; }
  function brain() { return global.AAA_FIELD_BRAIN; }
  function quote() { return global.AAA_MEASUREMENT_QUOTE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const Session = {
    COLLECTION: COLLECTION,

    /** Begin a job-optional capture session. */
    async start(opts) {
      const o = opts || {};
      const id = newId('fcs');
      const rec = { id: id, workspaceId: ws(), status: 'capturing', customerId: o.customerId || null, jobId: o.jobId || null, roomIds: [], quote: null, createdAt: nowISO(), updatedAt: nowISO() };
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    /** Capture a room into the session (reuses the measurement store + models). */
    async addRoom(sessionId, room) {
      const sess = await this.get(sessionId);
      if (!sess) return { ok: false, error: 'SESSION_NOT_FOUND' };
      if (!store()) return { ok: false, error: 'MEASUREMENT_STORE_UNAVAILABLE' };
      const saved = await store().saveSession(Object.assign({ roomName: 'Room ' + (sess.roomIds.length + 1), jobId: sess.jobId, customerId: sess.customerId, source: (room && room.source) || 'manual' }, room || {}));
      const rec = saved && saved.session;
      if (!rec || !rec.id) return { ok: false, error: 'SAVE_FAILED' };
      const upd = Object.assign({}, sess, { roomIds: sess.roomIds.concat([rec.id]), updatedAt: nowISO() });
      await data().put(COLLECTION, sessionId, upd);
      return { ok: true, room: rec, session: upd };
    },

    /** The captured room measurement-sessions for this capture session. */
    async rooms(sessionId) {
      const sess = await this.get(sessionId);
      if (!sess || !store()) return [];
      const out = [];
      for (const rid of sess.roomIds) { const r = await store().getSession(rid); if (r) out.push(r); }
      return out;
    },

    /** Physical aggregate + material plan + labor estimate (the Field Brain view). */
    async summarize(sessionId) {
      const rooms = await this.rooms(sessionId);
      if (!brain()) return { status: 'unavailable' };
      const agg = brain().aggregate(rooms);
      if (agg.status !== 'derived') return agg;
      return {
        status: 'derived', roomCount: agg.roomCount,
        totalSquareFeet: agg.totalSquareFeet, totalLinearFeet: agg.totalLinearFeet, totalStairs: agg.totalStairs,
        materialPlan: brain().materialPlan(agg.totalSquareFeet, {}),
        labor: brain().laborHours(agg.totalSquareFeet, agg.totalStairs, {})
      };
    },

    /**
     * Build ONE aggregated quote draft across all captured rooms via the shared
     * pricing engine. Stores the draft on the session. Always needsReview.
     */
    async buildQuoteDraft(sessionId, opts) {
      const o = opts || {};
      const rooms = await this.rooms(sessionId);
      if (!rooms.length) return { status: 'insufficient_data', note: 'No rooms captured yet.' };
      const summary = await this.summarize(sessionId);
      if (!quote()) return { status: 'physical_only', summary: summary, note: 'Pricing engine unavailable — captured measurements only.' };
      const selections = brain().serviceSelections(rooms, { service: o.service || 'carpet_install' });
      const q = quote().buildQuote(selections);
      const draft = { status: 'drafted', summary: summary, quote: q, service: o.service || 'carpet_install', needsReview: true, builtAt: nowISO() };
      const sess = await this.get(sessionId);
      if (sess) await data().put(COLLECTION, sessionId, Object.assign({}, sess, { quote: q, status: 'quoted', updatedAt: nowISO() }));
      return draft;
    },

    /**
     * Attach this session (and its captured rooms) to a job. Links field data
     * (re-saves rooms with the jobId) and returns estimate entries the caller
     * can persist onto the job — it does NOT mutate the job's record itself.
     */
    async attachToJob(sessionId, jobId) {
      const sess = await this.get(sessionId);
      if (!sess) return { ok: false, error: 'SESSION_NOT_FOUND' };
      const rooms = await this.rooms(sessionId);
      for (const r of rooms) { try { await store().saveSession(Object.assign({}, r, { jobId: jobId })); } catch (_) {} }
      const upd = Object.assign({}, sess, { jobId: jobId, status: 'attached', updatedAt: nowISO() });
      await data().put(COLLECTION, sessionId, upd);
      let estimateEntries = null;
      if (sess.quote && quote() && quote().toEstimateEntries) { try { estimateEntries = quote().toEstimateEntries(sess.quote, { jobId: jobId, source: 'field_capture', reviewRequired: true }); } catch (_) {} }
      return { ok: true, session: upd, estimateEntries: estimateEntries };
    },

    // ---- keyboard-free active-room capture (driven by the Bluetooth bridge) ----
    /** Begin (or reset) the room currently being measured. */
    async beginRoom(sessionId, opts) {
      const o = opts || {};
      const sess = await this.get(sessionId);
      if (!sess) return { ok: false, error: 'SESSION_NOT_FOUND' };
      const draft = { roomName: o.roomName || ('Room ' + (sess.roomIds.length + 1)), length: null, width: null, stairsCount: o.stairsCount || 0 };
      await data().put(COLLECTION, sessionId, Object.assign({}, sess, { activeDraft: draft, updatedAt: nowISO() }));
      return { ok: true, draft: draft };
    },

    /**
     * Set a dimension on the active room from a (feet) reading. 'generic' fills
     * the next empty slot (length then width). When both length and width are
     * present the room is committed via addRoom and the draft clears.
     */
    async setDimension(sessionId, valueFt, dimension) {
      const sess = await this.get(sessionId);
      if (!sess) return { ok: false, error: 'SESSION_NOT_FOUND' };
      const v = Number(valueFt);
      if (!isFinite(v) || v <= 0) return { ok: false, error: 'INVALID_MEASUREMENT' };
      let draft = sess.activeDraft || { roomName: 'Room ' + (sess.roomIds.length + 1), length: null, width: null, stairsCount: 0 };
      draft = Object.assign({}, draft);
      let slot = dimension;
      if (dimension === 'generic' || !dimension) slot = (draft.length == null ? 'length' : (draft.width == null ? 'width' : 'length'));
      if (slot === 'length' || slot === 'width') draft[slot] = Math.round(v * 100) / 100;
      else if (slot === 'height') draft.height = Math.round(v * 100) / 100; // captured, not used for carpet area
      else return { ok: false, error: 'UNKNOWN_DIMENSION' };

      if (draft.length != null && draft.length > 0 && draft.width != null && draft.width > 0) {
        await data().put(COLLECTION, sessionId, Object.assign({}, sess, { activeDraft: null, updatedAt: nowISO() }));
        const added = await this.addRoom(sessionId, { roomName: draft.roomName, length: draft.length, width: draft.width, stairsCount: draft.stairsCount, source: 'bluetooth' });
        return { ok: true, committed: true, room: added.room, dimension: slot, value: draft[slot] };
      }
      await data().put(COLLECTION, sessionId, Object.assign({}, sess, { activeDraft: draft, updatedAt: nowISO() }));
      return { ok: true, committed: false, draft: draft, dimension: slot, value: draft[slot] };
    },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },

    async activeDraft(sessionId) { const s = await this.get(sessionId); return s ? (s.activeDraft || null) : null; },

    async list() { return (await data().list(COLLECTION)).filter(mine).sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }); }
  };

  global.AAA_FIELD_CAPTURE_SESSION = Session;
})(typeof window !== 'undefined' ? window : this);
