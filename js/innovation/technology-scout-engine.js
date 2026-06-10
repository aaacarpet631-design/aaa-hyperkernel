/*
 * AAA Technology Scout Engine — track and score tools worth adopting.
 *
 * Maintains an append-only registry of tracked technologies (AI models,
 * hardware, vision systems, measurement devices, productivity tools) and scores
 * each on ROI from EXPLICIT inputs: annual labor/value gain vs implementation +
 * annual cost. It computes nothing it was not given — a technology with no
 * cost/benefit inputs is unscored (insufficient_data), never assigned a
 * hopeful ROI. Deterministic; read/write only its own store.
 *
 * Output: { technology, roiEstimate, implementationCost, recommendation }.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'tracked_technologies';
  const CATEGORIES = ['ai_model', 'hardware', 'vision_system', 'measurement_device', 'productivity_tool'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  const Engine = {
    COLLECTION: COLLECTION, CATEGORIES: CATEGORIES.slice(),

    /** Track a technology (append-only). */
    async track(tech) {
      const t = tech || {};
      const id = newId('tech');
      const rec = { id: id, workspaceId: ws(), technology: t.technology || 'unnamed', category: CATEGORIES.indexOf(t.category) !== -1 ? t.category : 'productivity_tool', annualBenefit: num(t.annualBenefit), implementationCost: num(t.implementationCost), annualCost: num(t.annualCost), createdAt: nowISO() };
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    /** Score one technology record's first-year ROI. */
    score(rec) {
      const benefit = num(rec.annualBenefit);
      const impl = num(rec.implementationCost);
      const annual = num(rec.annualCost) || 0;
      if (benefit == null || impl == null) return { technology: rec.technology, roiEstimate: null, implementationCost: impl, recommendation: 'Insufficient data — supply annual benefit + implementation cost.', status: 'insufficient_data' };
      const firstYearNet = benefit - annual - impl;
      const roiEstimate = impl + annual > 0 ? Math.round((firstYearNet / (impl + annual)) * 1000) / 1000 : null;
      let recommendation;
      if (roiEstimate == null) recommendation = 'Cost basis is zero — verify inputs.';
      else if (roiEstimate >= 1) recommendation = 'Adopt — pays back within the first year.';
      else if (roiEstimate >= 0) recommendation = 'Pilot — positive but slow payback; validate with a small test.';
      else recommendation = 'Hold — negative first-year ROI on current inputs.';
      return { technology: rec.technology, category: rec.category, roiEstimate: roiEstimate, implementationCost: impl, firstYearNet: firstYearNet, recommendation: recommendation, status: 'derived' };
    },

    /** Score every tracked technology, best ROI first. */
    async scoreAll() {
      const all = (await data().list(COLLECTION)).filter(mine);
      return all.map((r) => this.score(r)).sort((a, b) => (b.roiEstimate == null ? -Infinity : b.roiEstimate) - (a.roiEstimate == null ? -Infinity : a.roiEstimate));
    }
  };

  global.AAA_TECHNOLOGY_SCOUT_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
