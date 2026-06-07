/*
 * governance-ledger-audit — Netlify SCHEDULED function: continuous integrity
 * monitoring of the governance audit ledger.
 *
 * On a schedule (and on manual POST), it pulls the cloud-persisted ledger and
 * re-verifies the SHA-256 chain server-side (reusing verifyShaChain). On any
 * break it raises a critical, PII-free alert through the existing
 * /api/governance-alert email channel. This catches tampering between the
 * scheduled runs, independent of any client.
 *
 * Pure helpers (auditEntries, buildAlert) are exported for offline tests.
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read the ledger past RLS);
 *      URL/DEPLOY_URL (this site, to reach the alert function).
 */
import { verifyShaChain } from './governance-verify.mjs';

const AUDIT_COLLECTION = 'governance_audit';

/** Build a PII-free integrity alert from a verification break. */
export function buildAlert(brk, count) {
  return {
    kind: 'ledger_integrity', domain: 'governance', category: 'audit_ledger', severity: 'critical', priority: 'critical',
    metric: 'ledger_verification', value: brk.reason,
    threshold: 0, count: count, affectedCaseIds: [],
    detail: 'Governance audit ledger FAILED SHA-256 verification: ' + brk.reason +
      ' (writer ' + (brk.writerId || '?') + ', seq ' + (brk.brokenAt != null ? brk.brokenAt : '?') + ').',
    recommendedAction: 'Investigate the governance_audit store for tampering and restore from a verified copy. ' +
      'This indicates a record was altered outside the append-only governance flow.'
  };
}

/** Re-verify a set of ledger entries; return { ok, entries, alert? }. Pure. */
export function auditEntries(entries) {
  const res = verifyShaChain(entries || []);
  if (res.ok) return { ok: true, entries: (entries || []).length, verified: true };
  return { ok: false, entries: (entries || []).length, break: res, alert: buildAlert(res, (entries || []).length) };
}

async function fetchLedger(env) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: 'NO_DB' };
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/governance_store?select=doc_id,data&collection=eq.' + AUDIT_COLLECTION, {
      headers: { apikey: key, authorization: 'Bearer ' + key }
    });
    if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
    const rows = await res.json();
    return { ok: true, entries: (rows || []).map((r) => r.data) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function sendAlert(env, alert) {
  const base = env.URL || env.DEPLOY_URL || '';
  try { await fetch(base + '/api/governance-alert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alert) }); } catch (_) { /* best-effort */ }
}

export default async (req) => {
  const env = process.env;
  const led = await fetchLedger(env);
  if (!led.ok) {
    return new Response(JSON.stringify({ ok: false, error: led.error, skipped: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const result = auditEntries(led.entries);
  if (!result.ok && result.alert) await sendAlert(env, result.alert);
  return new Response(JSON.stringify({ ok: result.ok, entries: result.entries, reason: result.break && result.break.reason }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// Daily integrity sweep. (Netlify scheduled function.)
export const config = { schedule: '@daily' };
