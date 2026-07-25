/*
 * AAA Copilot Remote Adapter — the ONLY path from HyperKernel Chat to the
 * Custonllm copilot endpoint (mission Slice E).
 *
 * ask({job, message, quoteId}) assembles the permission-scoped context packet
 * (Slice C), wraps it in a contract-v1 request envelope, validates the
 * REQUEST before it leaves, POSTs to the configured endpoint under the
 * request's OWN latency budget (client-side deadline), and validates the
 * RESPONSE (schema + groundedness + requestId echo + evidence referential
 * integrity) before anyone sees it. FAIL CLOSED: an unconfigured endpoint, a
 * network failure, a deadline overrun, or a schema/groundedness/evidence-
 * violating reply all return an honest { ok:false, error, fallback:'local',
 * degraded } so the caller degrades to the local Executive Copilot — a remote
 * answer that can't prove itself is discarded, never rendered.
 *
 * Every result (success or failure) carries timing
 * { latencyMs, packetMs, fetchMs, withinBudget } and is recorded into
 * AAA_COPILOT_TELEMETRY when that module is present (codes and numbers only,
 * never message text). Identical concurrent asks (same workspace + job +
 * quoteId + message) share ONE in-flight request. Non-2xx replies that carry
 * a contract errorEnvelope surface as REMOTE_REFUSED with the server's code.
 *
 * Configuration: AAA_CONFIG flag 'copilotEndpoint' (absolute URL of the
 * Custonllm POST /copilot route, normally a same-origin server proxy so no
 * credentials live in the client). Unset = adapter honestly absent.
 * No retries, no caching, no mutation of anything.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function ids() { return global.AAA_ID_FACTORY; }
  function contract() { return global.AAA_COPILOT_CONTRACT; }
  function context() { return global.AAA_COPILOT_CONTEXT; }
  function rbac() { return global.AAA_RBAC; }
  function telemetry() { return global.AAA_COPILOT_TELEMETRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function newId() { return ids() && ids().createId ? ids().createId('creq') : 'creq_' + Math.random().toString(36).slice(2, 10); }
  function role() { const r = rbac(); const v = r && r.role ? r.role() : 'owner'; return ['owner', 'manager', 'crew'].indexOf(v) !== -1 ? v : 'crew'; }
  function tnow() {
    const clk = global.AAA_RUNTIME_CLOCK;
    return clk && typeof clk.now === 'function' ? clk.now() : Date.now();
  }

  // Budget flags sanitized: a non-finite or negative flag value falls back to
  // the contract-safe default rather than shipping garbage in the envelope.
  const DEFAULT_P95_MS = 6000;
  const DEFAULT_MAX_COST_USD = 0.15;
  function latencyBudgetMs() {
    const n = Number(flag('copilotP95LatencyMs', DEFAULT_P95_MS));
    return isFinite(n) && n >= 1 ? n : DEFAULT_P95_MS;
  }
  function costBudgetUSD() {
    const n = Number(flag('copilotMaxCostUSD', DEFAULT_MAX_COST_USD));
    return isFinite(n) && n >= 0 ? n : DEFAULT_MAX_COST_USD;
  }

  // Degraded-reason surfacing: every failure maps to a contract-shaped
  // degraded object so the UI/telemetry can show WHY the copilot fell back.
  function degradedReason(error) {
    const e = String(error || '');
    if (e === 'REMOTE_TIMEOUT') return 'budget_exceeded';
    if (e === 'PACKET_FAILED') return 'context_unavailable';
    if (e === 'NO_ENDPOINT' || e === 'NO_CONTRACT' || e === 'NO_CONTEXT' || e === 'NO_FETCH' || e === 'REQUEST_INVALID') return 'adapter_unavailable';
    return 'model_unavailable'; // NETWORK_ERROR, REMOTE_HTTP_*, REMOTE_INVALID, REMOTE_NOT_JSON, REMOTE_REFUSED
  }

  function fail(error, extra) {
    return Object.assign({
      ok: false,
      error: error,
      fallback: 'local',
      degraded: { reason: degradedReason(error), fallback: 'local' }
    }, extra || {});
  }

  // Single-flight dedupe: identical concurrent asks share one promise.
  const INFLIGHT = {};
  function inflightKey(i) {
    return [ws(), String(i.job == null ? '' : i.job), String(i.quoteId == null ? '' : i.quoteId), String(i.message == null ? '' : i.message)].join('\u0000');
  }

  const TIMEOUT_SENTINEL = { __aaaCopilotTimeout: true };

  async function runAsk(i) {
    const t0 = tnow();
    const budgetMs = latencyBudgetMs();
    let packetMs = 0, fetchMs = 0;

    // Attach timing to EVERY result and record it (codes + numbers only).
    function finish(result) {
      const latencyMs = Math.max(0, tnow() - t0);
      const timedOut = result.error === 'REMOTE_TIMEOUT';
      result.timing = {
        latencyMs: latencyMs,
        packetMs: packetMs,
        fetchMs: fetchMs,
        withinBudget: !timedOut && latencyMs <= budgetMs
      };
      const tel = telemetry();
      if (tel && typeof tel.record === 'function') {
        try {
          tel.record({
            job: typeof i.job === 'string' ? i.job : 'unknown',
            outcome: result.ok ? 'remote_ok' : 'remote_failed',
            error: result.ok ? undefined : result.error,
            latencyMs: latencyMs,
            budgetMs: budgetMs
          });
        } catch (_) { /* telemetry must never break the ask path */ }
      }
      return result;
    }

    const endpoint = flag('copilotEndpoint', null);
    if (!endpoint) return finish(fail('NO_ENDPOINT'));
    const c = contract();
    if (!c) return finish(fail('NO_CONTRACT'));
    const ctx = context();
    if (!ctx || !ctx.assemble) return finish(fail('NO_CONTEXT'));
    if (typeof global.fetch !== 'function') return finish(fail('NO_FETCH'));

    const packetStart = tnow();
    const packet = await ctx.assemble(i.job, { quoteId: i.quoteId });
    packetMs = Math.max(0, tnow() - packetStart);
    if (!packet.ok) return finish(fail('PACKET_FAILED', { reason: packet.error }));

    const request = {
      contractVersion: c.VERSION,
      requestId: newId(),
      workspaceId: ws(),
      identity: { role: role() },
      job: i.job,
      message: String(i.message == null ? '' : i.message).slice(0, 4000),
      contextPacket: packet.packet,
      budgets: {
        p95LatencyMs: budgetMs,
        maxCostUSDPerConversation: costBudgetUSD()
      }
    };
    const rv = c.validateRequest(request);
    if (!rv.ok) return finish(fail('REQUEST_INVALID', { issues: rv.issues }));

    // Client-side deadline: ONE timer covers the whole remote exchange —
    // headers AND body. A server that answers headers within budget and then
    // stalls (or trickles) the body is still cut off at the deadline; without
    // this, `await res.json()` would hang past the budget with the timer
    // already cleared. AbortController when the platform has one (so the
    // socket is actually torn down), Promise.race either way.
    const fetchStart = tnow();
    let httpRes = null;
    let timer = null;
    let timedOut = false;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    try {
      const fetchInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      };
      if (controller) fetchInit.signal = controller.signal;
      const fetchP = global.fetch(endpoint, fetchInit);
      const deadlineP = new Promise(function (resolve) {
        timer = setTimeout(function () {
          timedOut = true;
          if (controller) { try { controller.abort(); } catch (_) { /* already settled */ } }
          resolve(TIMEOUT_SENTINEL);
        }, budgetMs);
      });
      // Race a promise against the shared deadline; stragglers never surface
      // as unhandled rejections.
      const underDeadline = async function (p) {
        const w = await Promise.race([p, deadlineP]);
        if (w === TIMEOUT_SENTINEL) Promise.resolve(p).catch(function () {});
        return w;
      };

      const winner = await underDeadline(fetchP);
      if (winner === TIMEOUT_SENTINEL) {
        fetchMs = Math.max(0, tnow() - fetchStart);
        return finish(fail('REMOTE_TIMEOUT', { budgetMs: budgetMs }));
      }
      httpRes = winner;
      fetchMs = Math.max(0, tnow() - fetchStart);

      if (!httpRes || httpRes.ok === false) {
        // The agreed unhappy path: a non-2xx that carries a contract
        // errorEnvelope is a REFUSAL with a machine-readable code, not just an
        // HTTP number. Anything else stays the bare status. The refusal body
        // read runs under the same deadline.
        let body = null;
        if (httpRes && typeof httpRes.json === 'function') {
          try {
            const w2 = await underDeadline(httpRes.json());
            body = w2 === TIMEOUT_SENTINEL ? null : w2;
          } catch (_) { body = null; }
        }
        if (body && typeof c.validateError === 'function' && c.validateError(body).ok) {
          return finish(fail('REMOTE_REFUSED', { code: body.error.code, status: httpRes.status }));
        }
        return finish(fail('REMOTE_HTTP_' + ((httpRes && httpRes.status) || 'ERROR')));
      }

      let response = null;
      try {
        const w3 = await underDeadline(httpRes.json());
        if (w3 === TIMEOUT_SENTINEL) {
          fetchMs = Math.max(0, tnow() - fetchStart);
          return finish(fail('REMOTE_TIMEOUT', { budgetMs: budgetMs, phase: 'body' }));
        }
        response = w3;
      } catch (_) { return finish(fail('REMOTE_NOT_JSON')); }
      fetchMs = Math.max(0, tnow() - fetchStart);

      // Fail closed: the reply must prove itself before anyone renders it.
      const vv = c.validateResponse(response);
      if (!vv.ok) return finish(fail('REMOTE_INVALID', { issues: vv.issues }));
      if (response.requestId !== request.requestId) return finish(fail('REMOTE_INVALID', { issues: ['requestId mismatch'] }));
      const g = c.groundednessIssues(response);
      if (g.length) return finish(fail('REMOTE_INVALID', { issues: g }));
      // Referential integrity: every cited sourceRef must name a record the
      // request's packet actually carried. A fabricated citation dies here.
      if (typeof c.evidenceIntegrityIssues === 'function') {
        const ei = c.evidenceIntegrityIssues(request, response);
        if (ei.length) return finish(fail('REMOTE_INVALID', { issues: ei }));
      }

      return finish({ ok: true, response: response, request: request });
    } catch (e) {
      fetchMs = Math.max(0, tnow() - fetchStart);
      if (timedOut) return finish(fail('REMOTE_TIMEOUT', { budgetMs: budgetMs }));
      return finish(fail('NETWORK_ERROR', { detail: String((e && e.message) || e) }));
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  const Remote = {
    /** True when an endpoint is configured — the caller's routing signal. */
    configured() { return !!flag('copilotEndpoint', null); },

    /**
     * input: { job, message, quoteId?, budgets? }
     * → { ok:true, response, request, timing } (contract-valid + grounded +
     *   packet-cited) or { ok:false, error, fallback:'local', degraded,
     *   timing, issues? }. Identical concurrent calls share one request.
     */
    async ask(input) {
      const i = input || {};
      const key = inflightKey(i);
      if (INFLIGHT[key]) return INFLIGHT[key];
      const p = (async function () {
        try { return await runAsk(i); }
        finally { delete INFLIGHT[key]; }
      })();
      INFLIGHT[key] = p;
      return p;
    }
  };

  global.AAA_COPILOT_REMOTE = Remote;
})(typeof window !== 'undefined' ? window : this);
