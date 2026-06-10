/*
 * AAA Silence Analyzer — read the buying stage from activity (and its absence).
 *
 * Classifies a lead/estimate into a buying stage from real recency of contact:
 *   Interested · Evaluating · Comparing · ReadyToBuy · Ghosted · Lost
 * using the time since last activity and the resolution status. Ghosting is a
 * data fact (no contact in N days on an unresolved estimate), not a guess.
 * Deterministic; read-only.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  const WON = ['won', 'accepted', 'closed_won']; const LOST = ['lost', 'rejected', 'closed_lost'];

  const STAGES = ['Interested', 'Evaluating', 'Comparing', 'ReadyToBuy', 'Ghosted', 'Lost'];

  const Engine = {
    STAGES: STAGES.slice(),

    /**
     * @param record { status, lastActivityAt|updatedAt|createdAt, contactCount } → { stage, daysSilent, status }.
     */
    stageOf(record, now) {
      const r = record || {};
      const ref = now != null ? now : nowMs();
      const s = lc(r.status);
      if (WON.indexOf(s) !== -1) return { stage: 'ReadyToBuy', resolved: 'won', daysSilent: 0, status: 'derived' };
      if (LOST.indexOf(s) !== -1) return { stage: 'Lost', resolved: 'lost', daysSilent: null, status: 'derived' };
      const last = Date.parse(r.lastActivityAt || r.updatedAt || r.createdAt);
      if (!isFinite(last)) return { stage: 'Interested', daysSilent: null, status: 'insufficient_data' };
      const days = (ref - last) / 86400000;
      const ghostDays = flag('silenceGhostDays', 7);
      const contacts = num(r.contactCount, 0);
      let stage;
      if (days >= ghostDays * 2) stage = 'Ghosted';
      else if (days >= ghostDays) stage = 'Ghosted';
      else if (contacts >= 3) stage = 'Comparing';
      else if (contacts === 2) stage = 'Evaluating';
      else stage = 'Interested';
      return { stage: stage, daysSilent: Math.round(days * 10) / 10, status: 'derived' };
    },

    /** Estimates currently ghosting (recovery targets). */
    async ghosting(records, now) {
      const ref = now != null ? now : nowMs();
      return (Array.isArray(records) ? records : []).map((r) => ({ id: r.id, stage: this.stageOf(r, ref) })).filter((x) => x.stage.stage === 'Ghosted');
    }
  };

  global.AAA_SILENCE_ANALYZER = Engine;
})(typeof window !== 'undefined' ? window : this);
