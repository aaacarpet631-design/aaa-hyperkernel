/*
 * AAA Governance Escalation — the generic notification/escalation layer for
 * governance risks. The drift signal from repeated overrides is its first
 * trigger, but it is built for any future governance risk (legal, accounting,
 * contract, ad copy, SMS, email, AI-agent) via escalate({ kind, domain, … }).
 *
 * It complements the dashboard signal (which stays as-is): the dashboard shows
 * the count; THIS module decides when to actually alert the owner/admin, and
 * does so without spamming.
 *
 * Controls:
 *  - Threshold windowing: an escalation is keyed by (kind, domain, category,
 *    windowIndex = floor(count / threshold)). One escalation per window — so we
 *    do NOT alert on every override, only on a crossing.
 *  - Cooldown: while an escalation is OPEN and its count keeps climbing inside
 *    the same window, re-notification is rate-limited by a cooldown.
 *  - Status lifecycle: open → acknowledged → resolved. A resolved window never
 *    re-opens; only a NEW window (another threshold's worth of overrides) raises
 *    a fresh escalation.
 *  - Every raise / notify / acknowledge / resolve is written to the immutable
 *    governance audit ledger.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function rbac() { return global.AAA_RBAC; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function events() { return global.AAA_EVENTS; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const COLLECTION = 'governance_escalations';
  const DEFAULT_THRESHOLD = 3;
  const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h — don't re-alert constantly

  function cooldownMs() { return +(cfg().flag ? cfg().flag('governanceEscalationCooldownMs', DEFAULT_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS); }

  // ---- pure helpers (exported for tests) ------------------------------------

  function windowIndexFor(count, threshold) {
    const t = +threshold || DEFAULT_THRESHOLD;
    if (t <= 0) return 0;
    return Math.floor((+count || 0) / t);
  }

  function cooldownElapsed(lastAt, atNow, cdMs) {
    if (lastAt == null) return true;
    return (atNow - lastAt) >= cdMs;
  }

  function slug(s) { return String(s == null ? 'unknown' : s).replace(/[^a-z0-9]+/gi, '_').toLowerCase(); }

  function escalationId(kind, domain, category, windowIndex) {
    return 'gesc_' + slug(kind) + '_' + slug(domain) + '_' + slug(category) + '_w' + windowIndex;
  }

  function recommendDrift(domain, category, count, threshold, guardrail) {
    return 'Review the ' + (guardrail || domain) + ' guardrail for category "' + category + '": ' +
      count + ' Admin overrides (threshold ' + threshold + ') indicate likely false positives or model drift. ' +
      'Recommended: sample the affected cases, recalibrate or retrain the classifier for this category, ' +
      'and re-check its threshold before it suppresses legitimate output.';
  }

  // Domains whose escalations are always critical (legal/financial exposure).
  const HIGH_RISK_DOMAINS = ['legal', 'compliance', 'accounting', 'contract'];

  /**
   * Priority of an escalation — drives whether the notifier alerts a human.
   * 'critical' for high-exposure domains or sustained drift (≥2× threshold);
   * 'high' otherwise. Pure, so the notifier and tests share one definition.
   */
  function computePriority(e) {
    if (!e) return 'normal';
    if (HIGH_RISK_DOMAINS.indexOf(e.domain) !== -1) return 'critical';
    if ((+e.overrideCount || 0) >= 2 * (+e.threshold || Infinity)) return 'critical';
    return 'high';
  }

  // ---- internals ------------------------------------------------------------

  function actor(partial) {
    partial = partial || {};
    const uid = cfg().firebaseUid || (cfg().flag ? cfg().flag('firebaseUid', null) : null);
    return {
      id: partial.actorId || uid || 'system',
      role: (rbac() && rbac().role) ? rbac().role() : (partial.actorRole || 'system')
    };
  }

  async function get(id) { return (data() && data().get) ? data().get(COLLECTION, id) : null; }
  async function put(id, rec) { if (data() && data().put) await data().put(COLLECTION, id, rec); return rec; }

  function auditPayload(e, extra) {
    return Object.assign({
      escalationId: e.id, kind: e.kind, domain: e.domain, category: e.category,
      overrideCount: e.overrideCount, threshold: e.threshold,
      affectedCaseIds: e.affectedCaseIds || [], recommendedAction: e.recommendedAction,
      status: e.status, windowIndex: e.windowIndex
    }, extra || {});
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  function notify(e) {
    if (events()) events().emit('governance.escalation', { escalationId: e.id, kind: e.kind, domain: e.domain, category: e.category, status: e.status, priority: e.priority, overrideCount: e.overrideCount, threshold: e.threshold });
    try { if (data() && data().logAgent) data().logAgent('governance', 'Escalation: ' + e.category + ' (' + e.domain + ') — ' + e.overrideCount + ' ≥ ' + e.threshold, auditPayload(e)); } catch (_) {}
  }

  const Escalation = {
    COLLECTION: COLLECTION,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    // pure helpers
    windowIndexFor: windowIndexFor,
    cooldownElapsed: cooldownElapsed,
    escalationId: escalationId,
    recommendDrift: recommendDrift,
    computePriority: computePriority,

    /**
     * Generic escalation entry. Decides — based on count vs threshold, the
     * window, the current status, and the cooldown — whether to raise a new
     * escalation, re-notify an open one, or suppress. Returns
     * { ok, escalated, escalation?, suppressed?, reason? }.
     */
    async escalate(input) {
      input = input || {};
      const threshold = +input.threshold || DEFAULT_THRESHOLD;
      const count = +input.count || 0;
      const widx = windowIndexFor(count, threshold);
      if (widx < 1) return { ok: true, escalated: false, reason: 'BELOW_THRESHOLD' };

      const kind = input.kind || 'drift_override';
      const domain = input.domain || 'content_safety';
      const category = input.category || 'unknown';
      const id = escalationId(kind, domain, category, widx);
      const affected = Array.isArray(input.affectedCaseIds) ? input.affectedCaseIds : [];
      const recommended = input.recommendedAction || recommendDrift(domain, category, count, threshold, input.guardrail);
      const tnow = now();
      const existing = await get(id);

      if (existing) {
        // A resolved window is closed for good — only a NEW window re-escalates.
        if (existing.status === 'resolved') {
          return { ok: true, escalated: false, suppressed: true, reason: 'RESOLVED_WINDOW', escalation: existing };
        }
        const upd = Object.assign({}, existing, {
          overrideCount: count, affectedCaseIds: affected, recommendedAction: recommended, updatedAt: tnow
        });
        upd.priority = computePriority(upd);
        // Re-notify only while OPEN (acknowledged silences) and past cooldown.
        let renotified = false;
        if (existing.status === 'open' && cooldownElapsed(existing.lastNotifiedAt, tnow, cooldownMs())) {
          upd.lastNotifiedAt = tnow;
          upd.notifyCount = (existing.notifyCount || 0) + 1;
          await put(id, upd);
          await audit('escalation_notified', auditPayload(upd));
          notify(upd);
          renotified = true;
        } else {
          await put(id, upd);
        }
        return { ok: true, escalated: false, suppressed: !renotified, renotified: renotified, escalation: upd };
      }

      // New window crossing → raise + notify.
      const esc = {
        id: id, kind: kind, domain: domain, category: category,
        overrideCount: count, threshold: threshold, windowIndex: widx,
        affectedCaseIds: affected, recommendedAction: recommended,
        guardrail: input.guardrail || null, model: input.model || null,
        priority: computePriority({ domain: domain, overrideCount: count, threshold: threshold }),
        status: 'open', raisedAt: tnow, at: nowISO(),
        lastNotifiedAt: tnow, notifyCount: 1,
        acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null,
        updatedAt: tnow
      };
      await put(id, esc);
      await audit('escalation_raised', auditPayload(esc));
      notify(esc);
      return { ok: true, escalated: true, escalation: esc };
    },

    /** Drift convenience: count category overrides in the review queue, then escalate. */
    async evaluateDrift(input) {
      input = input || {};
      const domain = input.domain;
      const category = input.category;
      const threshold = +input.threshold || DEFAULT_THRESHOLD;
      if (!category) return { ok: true, escalated: false, reason: 'NO_CATEGORY' };
      const queue = (data() && data().list) ? await data().list('governance_review_queue') : [];
      const matches = (queue || []).filter(function (q) {
        return (!domain || q.domain === domain) && Array.isArray(q.categories) && q.categories.indexOf(category) !== -1;
      });
      const affectedCaseIds = matches.map(function (q) { return q.caseId; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      return this.escalate({
        kind: 'drift_override', domain: domain, category: category,
        count: matches.length, threshold: threshold, affectedCaseIds: affectedCaseIds,
        guardrail: matches.length ? matches[0].guardrail : null,
        model: matches.length ? matches[0].model : null
      });
    },

    /** Owner/admin acknowledges they are on it — silences re-notification. */
    async acknowledge(id, opts) {
      const e = await get(id);
      if (!e) return { ok: false, error: 'NOT_FOUND' };
      if (e.status === 'resolved') return { ok: false, error: 'ALREADY_RESOLVED' };
      const who = actor(opts);
      const upd = Object.assign({}, e, { status: 'acknowledged', acknowledgedAt: now(), acknowledgedBy: who.id, updatedAt: now() });
      await put(id, upd);
      await audit('escalation_acknowledged', auditPayload(upd, { actorId: who.id, actorRole: who.role }));
      return { ok: true, escalation: upd };
    },

    /** Resolve the escalation. The window stays closed unless a new one is hit. */
    async resolve(id, opts) {
      const e = await get(id);
      if (!e) return { ok: false, error: 'NOT_FOUND' };
      const who = actor(opts);
      const upd = Object.assign({}, e, { status: 'resolved', resolvedAt: now(), resolvedBy: who.id, resolvedAtCount: e.overrideCount, updatedAt: now() });
      await put(id, upd);
      await audit('escalation_resolved', auditPayload(upd, { actorId: who.id, actorRole: who.role }));
      return { ok: true, escalation: upd };
    },

    async list() { return (data() && data().list) ? data().list(COLLECTION) : []; },
    async open() { return (await this.list()).filter(function (e) { return e.status === 'open' || e.status === 'acknowledged'; }); }
  };

  global.AAA_GOVERNANCE_ESCALATION = Escalation;
})(typeof window !== 'undefined' ? window : this);
