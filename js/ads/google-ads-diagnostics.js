/*
 * AAA Google Ads Diagnostics — a READ-ONLY health monitor over the ads
 * measurement foundation (attribution ledger + conversion ledger + lead
 * pipeline + export batches).
 *
 * This module answers one question honestly: "can the ad algorithm trust the
 * data we are about to feed it?" It computes a checklist of measurement-health
 * checks and returns them as plain status rows. It NEVER repairs, NEVER
 * writes (zero put() calls anywhere — the store is byte-identical after a full
 * run, proven by test), and — like everything in this stack — never calls the
 * Google Ads API.
 *
 * healthReport() -> { ok:true, checks:[{ id, status:'pass'|'warn'|'fail',
 * detail, count? }], summary:{ pass, warn, fail } } with these checks:
 *
 *  - click_id_coverage   % of ad_attribution records carrying at least one
 *                        click id (gclid/gbraid/wbraid). Thresholds are config
 *                        flags: warn below 'adsClickIdCoverageWarnPct'
 *                        (default 80), fail below 'adsClickIdCoverageFailPct'
 *                        (default 50).
 *  - consent_coverage    % of attribution records whose consent is RESOLVED
 *                        ('granted' or 'denied'); 'unknown' is unresolved and
 *                        any unknown yields warn.
 *  - upload_blockers     histogram of uploadQueue().skipped reasons
 *                        (NO_CONSENT / NO_CLICK_ID / NO_ATTRIBUTION); warn
 *                        when anything is skipped, pass when the queue is
 *                        clean.
 *  - dedupe_integrity    every 'ads_conversion_events' id must equal
 *                        '<leadId>:<TYPE>' and no (leadId,type) pair may
 *                        appear twice. Any violation is fail (the ledger makes
 *                        this impossible; the check proves it).
 *  - orphan_events       conversion events whose leadId has no lead in
 *                        AAA_LEADS (warn, count).
 *  - missing_attribution paid-channel leads with no attribution record, via
 *                        AAA_LEADS.missingAttribution() (warn, count).
 *  - value_sanity        primary-signal events with a negative valueUSD or one
 *                        above flag('adsMaxSaneValueUSD', 100000) — fail with
 *                        count.
 *  - unreleased_backlog  bidding-eligible uploadable payloads not yet part of
 *                        any released batch in 'ads_conversion_exports'
 *                        (warn with count, pass when none).
 *
 * Honest + bounded by construction:
 *  - Null-tolerant: a missing module yields status 'warn' with detail
 *    'module unavailable'; an unexpected error inside a check yields warn —
 *    healthReport() never throws.
 *  - Ids-only in details: check details carry ids, reasons, counts and
 *    percentages — never customer names, phones, or per-customer dollar
 *    values.
 *  - Deterministic, no network, zero dependencies.
 */
;(function (global) {
  'use strict';

  const EVENTS_COLLECTION = 'ads_conversion_events';
  const EXPORTS_COLLECTION = 'ads_conversion_exports';
  const MAX_IDS_IN_DETAIL = 10; // details stay readable; counts stay exact

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(key, dflt) { return cfg().flag ? cfg().flag(key, dflt) : dflt; }
  function data() { return global.AAA_DATA; }
  function attribution() { return global.AAA_AD_ATTRIBUTION; }
  function ledger() { return global.AAA_ADS_CONVERSIONS; }
  function leads() { return global.AAA_LEADS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }

  function check(id, status, detail, count) {
    const c = { id: id, status: status, detail: String(detail == null ? '' : detail) };
    if (count != null) c.count = count;
    return c;
  }
  function unavailable(id) { return check(id, 'warn', 'module unavailable'); }
  function pct(part, total) { return total ? Math.round((part / total) * 1000) / 10 : 0; }
  function idsPreview(list) {
    const head = list.slice(0, MAX_IDS_IN_DETAIL).join(', ');
    return list.length > MAX_IDS_IN_DETAIL ? head + ', …' : head;
  }

  // ---- individual checks (each read-only, each null-tolerant) ---------------

  async function clickIdCoverage() {
    const id = 'click_id_coverage';
    const attr = attribution();
    if (!attr || !attr.list || !data()) return unavailable(id);
    const records = (await attr.list()) || [];
    if (!records.length) return check(id, 'pass', 'no attribution records yet (coverage vacuous)', 0);
    const covered = records.filter(function (r) { return r && (r.gclid || r.gbraid || r.wbraid); }).length;
    const coverage = pct(covered, records.length);
    // Documented defaults: warn below 80% coverage, fail below 50%.
    const warnFloor = Number(flag('adsClickIdCoverageWarnPct', 80));
    const failFloor = Number(flag('adsClickIdCoverageFailPct', 50));
    const status = coverage < failFloor ? 'fail' : (coverage < warnFloor ? 'warn' : 'pass');
    return check(id, status,
      coverage + '% of ' + records.length + ' attribution records have a click id (warn <' + warnFloor + ', fail <' + failFloor + ')',
      covered);
  }

  async function consentCoverage() {
    const id = 'consent_coverage';
    const attr = attribution();
    if (!attr || !attr.list || !data()) return unavailable(id);
    const records = (await attr.list()) || [];
    if (!records.length) return check(id, 'pass', 'no attribution records yet (coverage vacuous)', 0);
    const resolved = records.filter(function (r) { return r && (r.consent === 'granted' || r.consent === 'denied'); }).length;
    const unresolved = records.length - resolved;
    const coverage = pct(resolved, records.length);
    return check(id, unresolved > 0 ? 'warn' : 'pass',
      coverage + '% of ' + records.length + ' attribution records have resolved consent; ' + unresolved + ' unknown',
      unresolved);
  }

  async function uploadBlockers() {
    const id = 'upload_blockers';
    const led = ledger();
    if (!led || !led.uploadQueue || !data()) return unavailable(id);
    const q = await led.uploadQueue();
    const skipped = (q && q.skipped) || [];
    const histogram = {};
    skipped.forEach(function (s) {
      const reason = (s && s.reason) || 'UNKNOWN';
      histogram[reason] = (histogram[reason] || 0) + 1;
    });
    const parts = Object.keys(histogram).sort().map(function (k) { return k + ':' + histogram[k]; });
    const c = check(id, skipped.length > 0 ? 'warn' : 'pass',
      skipped.length ? 'skipped ' + skipped.length + ' event(s): ' + parts.join(', ')
        : 'upload queue clean (' + (((q && q.payloads) || []).length) + ' payload(s), 0 skipped)',
      skipped.length);
    c.histogram = histogram;
    return c;
  }

  async function dedupeIntegrity() {
    const id = 'dedupe_integrity';
    if (!data() || !data().list) return unavailable(id);
    const events = ((await data().list(EVENTS_COLLECTION)) || []).filter(mine);
    const seen = {};
    const bad = [];
    events.forEach(function (e) {
      if (!e) return;
      const expected = String(e.leadId) + ':' + String(e.type);
      if (e.id !== expected || !/^.+:[A-Z_]+$/.test(String(e.id))) { bad.push(String(e.id)); return; }
      if (seen[expected]) bad.push(String(e.id));
      seen[expected] = true;
    });
    return check(id, bad.length ? 'fail' : 'pass',
      bad.length ? 'malformed or duplicate (leadId,type) event ids: ' + idsPreview(bad)
        : events.length + ' event(s), all ids are unique <leadId>:<TYPE> keys',
      bad.length);
  }

  async function orphanEvents() {
    const id = 'orphan_events';
    const L = leads();
    if (!data() || !data().list) return unavailable(id);
    if (!L || !L.listLeads) return unavailable(id);
    const events = ((await data().list(EVENTS_COLLECTION)) || []).filter(mine);
    const known = {};
    ((await L.listLeads()) || []).forEach(function (l) { if (l && l.leadId) known[l.leadId] = true; });
    const orphanIds = [];
    events.forEach(function (e) { if (e && !known[e.leadId]) orphanIds.push(String(e.id)); });
    return check(id, orphanIds.length ? 'warn' : 'pass',
      orphanIds.length ? 'conversion events with no matching lead: ' + idsPreview(orphanIds)
        : 'every conversion event maps to a known lead',
      orphanIds.length);
  }

  async function missingAttribution() {
    const id = 'missing_attribution';
    const L = leads();
    if (!L || !L.missingAttribution || !data()) return unavailable(id);
    const missing = (await L.missingAttribution()) || [];
    const leadIds = missing.map(function (m) { return String(m && m.leadId); });
    return check(id, missing.length ? 'warn' : 'pass',
      missing.length ? 'paid-channel leads with no attribution record: ' + idsPreview(leadIds)
        : 'every paid-channel lead has an attribution record',
      missing.length);
  }

  async function valueSanity() {
    const id = 'value_sanity';
    const led = ledger();
    if (!led || !led.list || !led.isPrimarySignal || !data()) return unavailable(id);
    const maxSane = Number(flag('adsMaxSaneValueUSD', 100000)); // documented default: $100k
    const primary = (await led.list({ primaryOnly: true })) || [];
    const badIds = [];
    primary.forEach(function (e) {
      if (!e || e.valueUSD == null) return;
      const v = Number(e.valueUSD);
      if (!isFinite(v) || v < 0 || v > maxSane) badIds.push(String(e.id));
    });
    // Ids only — the offending dollar amounts are never echoed into the report.
    return check(id, badIds.length ? 'fail' : 'pass',
      badIds.length ? 'primary-signal events with negative/absurd valueUSD (cap ' + maxSane + '): ' + idsPreview(badIds)
        : primary.length + ' primary-signal event(s), all values within [0, ' + maxSane + ']',
      badIds.length);
  }

  async function unreleasedBacklog() {
    const id = 'unreleased_backlog';
    const led = ledger();
    if (!led || !led.uploadQueue || !data() || !data().list) return unavailable(id);
    const q = await led.uploadQueue();
    const payloads = (q && q.payloads) || [];
    const released = {};
    ((await data().list(EXPORTS_COLLECTION)) || []).filter(mine).forEach(function (b) {
      if (!b || b.status !== 'released') return;
      (b.payloads || []).forEach(function (p) { if (p && p.eventId) released[p.eventId] = true; });
    });
    const backlogIds = [];
    payloads.forEach(function (p) { if (p && !released[p.eventId]) backlogIds.push(String(p.eventId)); });
    return check(id, backlogIds.length ? 'warn' : 'pass',
      backlogIds.length ? 'uploadable payloads not yet in any released export batch: ' + idsPreview(backlogIds)
        : payloads.length + ' uploadable payload(s), all covered by released batches',
      backlogIds.length);
  }

  // ---- public surface --------------------------------------------------------

  const Diagnostics = {
    CHECK_IDS: ['click_id_coverage', 'consent_coverage', 'upload_blockers', 'dedupe_integrity',
      'orphan_events', 'missing_attribution', 'value_sanity', 'unreleased_backlog'],

    /**
     * Run every measurement-health check. Read-only: this module owns no
     * collection and never calls put(). Never throws — a broken or missing
     * dependency degrades the affected check to warn.
     */
    async healthReport() {
      const fns = [clickIdCoverage, consentCoverage, uploadBlockers, dedupeIntegrity,
        orphanEvents, missingAttribution, valueSanity, unreleasedBacklog];
      const checks = [];
      for (let i = 0; i < fns.length; i++) {
        let c;
        try { c = await fns[i](); } catch (_) { c = check(Diagnostics.CHECK_IDS[i], 'warn', 'check errored (treated as unknown health)'); }
        checks.push(c);
      }
      const summary = { pass: 0, warn: 0, fail: 0 };
      checks.forEach(function (c) { summary[c.status] = (summary[c.status] || 0) + 1; });
      return { ok: true, checks: checks, summary: summary };
    }
  };

  global.AAA_ADS_DIAGNOSTICS = Diagnostics;
})(typeof window !== 'undefined' ? window : this);
