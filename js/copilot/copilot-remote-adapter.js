/*
 * AAA Copilot Remote Adapter — the ONLY path from HyperKernel Chat to the
 * Custonllm copilot endpoint (mission Slice E).
 *
 * ask({job, message, quoteId}) assembles the permission-scoped context packet
 * (Slice C), wraps it in a contract-v1 request envelope, validates the
 * REQUEST before it leaves, POSTs to the configured endpoint, and validates
 * the RESPONSE (schema + groundedness + requestId echo) before anyone sees
 * it. FAIL CLOSED: an unconfigured endpoint, a network failure, or a
 * schema/groundedness-violating reply all return an honest
 * { ok:false, error, fallback:'local' } so the caller degrades to the local
 * Executive Copilot — a remote answer that can't prove itself is discarded,
 * never rendered.
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
  function ws() { return cfg().workspaceId || 'default'; }
  function newId() { return ids() && ids().createId ? ids().createId('creq') : 'creq_' + Math.random().toString(36).slice(2, 10); }
  function role() { const r = rbac(); const v = r && r.role ? r.role() : 'owner'; return ['owner', 'manager', 'crew'].indexOf(v) !== -1 ? v : 'crew'; }

  function fail(error, extra) { return Object.assign({ ok: false, error: error, fallback: 'local' }, extra || {}); }

  const Remote = {
    /** True when an endpoint is configured — the caller's routing signal. */
    configured() { return !!flag('copilotEndpoint', null); },

    /**
     * input: { job, message, quoteId?, budgets? }
     * → { ok:true, response } (contract-valid + grounded) or
     *   { ok:false, error, fallback:'local', issues? }.
     */
    async ask(input) {
      const i = input || {};
      const endpoint = flag('copilotEndpoint', null);
      if (!endpoint) return fail('NO_ENDPOINT');
      const c = contract();
      if (!c) return fail('NO_CONTRACT');
      const ctx = context();
      if (!ctx || !ctx.assemble) return fail('NO_CONTEXT');
      if (typeof global.fetch !== 'function') return fail('NO_FETCH');

      const packet = await ctx.assemble(i.job, { quoteId: i.quoteId });
      if (!packet.ok) return fail('PACKET_FAILED', { reason: packet.error });

      const request = {
        contractVersion: c.VERSION,
        requestId: newId(),
        workspaceId: ws(),
        identity: { role: role() },
        job: i.job,
        message: String(i.message == null ? '' : i.message).slice(0, 2000),
        contextPacket: packet.packet,
        budgets: {
          p95LatencyMs: Number(flag('copilotP95LatencyMs', 6000)),
          maxCostUSDPerConversation: Number(flag('copilotMaxCostUSD', 0.15))
        }
      };
      const rv = c.validateRequest(request);
      if (!rv.ok) return fail('REQUEST_INVALID', { issues: rv.issues });

      let httpRes = null;
      try {
        httpRes = await global.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request)
        });
      } catch (e) {
        return fail('NETWORK_ERROR', { detail: String((e && e.message) || e) });
      }
      if (!httpRes || httpRes.ok === false) return fail('REMOTE_HTTP_' + ((httpRes && httpRes.status) || 'ERROR'));

      let response = null;
      try { response = await httpRes.json(); } catch (_) { return fail('REMOTE_NOT_JSON'); }

      // Fail closed: the reply must prove itself before anyone renders it.
      const vv = c.validateResponse(response);
      if (!vv.ok) return fail('REMOTE_INVALID', { issues: vv.issues });
      if (response.requestId !== request.requestId) return fail('REMOTE_INVALID', { issues: ['requestId mismatch'] });
      const g = c.groundednessIssues(response);
      if (g.length) return fail('REMOTE_INVALID', { issues: g });

      return { ok: true, response: response, request: request };
    }
  };

  global.AAA_COPILOT_REMOTE = Remote;
})(typeof window !== 'undefined' ? window : this);
