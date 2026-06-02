/*
 * AAA Governance Notifier — turns governance escalation EVENTS into real
 * notifications, over a pluggable channel registry.
 *
 * Architecture (generic on purpose): it subscribes once to 'governance.escalation'
 * (the event the escalation engine already emits AFTER window/cooldown
 * suppression), gates on priority, then dispatches to every enabled channel.
 * Email is the only channel today; SMS/push register later via
 * registerChannel() with zero changes to the escalation engine.
 *
 * Safety:
 *  - Only high-priority events are delivered (governanceAlertMinPriority).
 *  - The payload sent to a channel is an explicit governance-metadata allowlist
 *    — never customer PII or the drafted message.
 *  - Every attempt → success/failure (with provider response + timestamp) is
 *    written to the immutable audit ledger.
 *  - A channel failure is caught and logged; it never throws into the app.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function events() { return global.AAA_EVENTS; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function escalations() { return global.AAA_GOVERNANCE_ESCALATION; }
  function nowISO() { return (global.AAA_RUNTIME_CLOCK && global.AAA_RUNTIME_CLOCK.nowISO) ? global.AAA_RUNTIME_CLOCK.nowISO() : new Date().toISOString(); }

  const RANK = { low: 0, normal: 1, high: 2, critical: 3 };
  // Only governance metadata is ever forwarded to a channel. No customer data.
  const ALLOWED = ['escalationId', 'kind', 'domain', 'category', 'count', 'threshold', 'affectedCaseIds', 'recommendedAction', 'dashboardUrl', 'priority', 'metric', 'value', 'detail', 'severity'];

  function minPriority() { return cfg().flag ? cfg().flag('governanceAlertMinPriority', 'high') : 'high'; }
  function endpoint() { return cfg().flag ? cfg().flag('governanceAlertEndpoint', '/api/governance-alert') : '/api/governance-alert'; }
  function dashboardUrl() { return cfg().flag ? cfg().flag('dashboardUrl', null) : null; }

  function meetsPriority(priority) {
    return (RANK[priority] != null ? RANK[priority] : RANK.high) >= (RANK[minPriority()] != null ? RANK[minPriority()] : RANK.high);
  }

  // Build the PII-free channel payload from an escalation record. Explicit
  // allowlist: anything not named here (e.g. a stray customer field) is dropped.
  function buildPayload(esc) {
    const out = {
      escalationId: esc.id, kind: esc.kind, domain: esc.domain, category: esc.category,
      count: esc.overrideCount, threshold: esc.threshold,
      metric: esc.metric, value: esc.value, detail: esc.detail, severity: esc.severity,
      affectedCaseIds: Array.isArray(esc.affectedCaseIds) ? esc.affectedCaseIds.slice() : [],
      recommendedAction: esc.recommendedAction, priority: esc.priority
    };
    const dash = dashboardUrl();
    if (dash) out.dashboardUrl = dash;
    // Final guard: keep only allowlisted keys.
    const clean = {};
    ALLOWED.forEach((k) => { if (out[k] != null) clean[k] = out[k]; });
    return clean;
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  // Default email channel — POSTs the allowlisted payload to the Netlify function.
  async function emailSend(payload) {
    const url = endpoint();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    let body = null; try { body = await res.json(); } catch (_) {}
    return { ok: res.ok && !(body && body.ok === false), status: res.status, response: body };
  }

  const channels = { email: { enabled: true, send: emailSend } };

  const Notifier = {
    buildPayload: buildPayload,
    meetsPriority: meetsPriority,

    /** Register/replace a channel (e.g. future 'sms', 'push'). */
    registerChannel(name, channel) { channels[name] = Object.assign({ enabled: true }, channel || {}); return this; },
    setChannelEnabled(name, on) { if (channels[name]) channels[name].enabled = !!on; return this; },
    channels() { return Object.keys(channels); },

    /** Subscribe to escalation events exactly once. */
    init() {
      if (this._wired || !events() || !events().on) return this;
      events().on('governance.escalation', (evt) => { this.handle(evt); });
      this._wired = true;
      return this;
    },

    /**
     * Handle one escalation event: gate on priority, resolve the full record,
     * dispatch to enabled channels, and audit every attempt. Never throws.
     */
    async handle(evt) {
      try {
        if (!evt || !meetsPriority(evt.priority)) {
          return { ok: true, delivered: false, reason: 'BELOW_PRIORITY' };
        }
        // Resolve the full, PII-free escalation record for the body.
        let esc = null;
        if (escalations() && escalations().list) {
          const all = await escalations().list();
          esc = (all || []).find((e) => e.id === evt.escalationId) || null;
        }
        if (!esc) esc = { id: evt.escalationId, kind: evt.kind, domain: evt.domain, category: evt.category, overrideCount: evt.overrideCount, threshold: evt.threshold, priority: evt.priority, affectedCaseIds: [], recommendedAction: '' };
        const payload = buildPayload(esc);

        const results = {};
        for (const name of Object.keys(channels)) {
          const ch = channels[name];
          if (!ch.enabled) continue;
          await audit('alert_attempt', { channel: name, escalationId: payload.escalationId, domain: payload.domain, category: payload.category, priority: payload.priority, at: nowISO() });
          try {
            const r = await ch.send(payload);
            results[name] = r;
            if (r && r.ok) {
              await audit('alert_delivered', { channel: name, escalationId: payload.escalationId, status: r.status, providerResponse: r.response || null, at: nowISO() });
            } else {
              await audit('alert_failed', { channel: name, escalationId: payload.escalationId, status: r && r.status, providerResponse: (r && r.response) || null, error: 'CHANNEL_REJECTED', at: nowISO() });
            }
          } catch (err) {
            // A delivery failure must never crash the app.
            results[name] = { ok: false, error: String((err && err.message) || err) };
            await audit('alert_failed', { channel: name, escalationId: payload.escalationId, error: String((err && err.message) || err), at: nowISO() });
          }
        }
        const delivered = Object.keys(results).some((n) => results[n] && results[n].ok);
        return { ok: true, delivered: delivered, results: results, payload: payload };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
  };

  // Auto-wire when the event bus is present.
  Notifier.init();

  global.AAA_GOVERNANCE_NOTIFIER = Notifier;
})(typeof window !== 'undefined' ? window : this);
