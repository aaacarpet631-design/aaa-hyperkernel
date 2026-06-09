/*
 * AAA Governed Model Router — the ONE canonical path to any external model.
 *
 * Nothing in HyperKernel calls a provider directly; everything goes through
 *   AAA_GOVERNED_MODEL_ROUTER.call({ modelKey, taskType, input, context,
 *      governanceRef, provenanceRef, ownerApprovalRequired, actor, origin, agent })
 * which enforces, in order:
 *   1. registry resolution + task-is-allowed-for-model,
 *   2. gateway gate (RUN_MODEL) — audits the attempt; crew/over-AI denied + logged,
 *   3. the model must be a GOVERNED, ACTIVE artifact (owner-activated) AND enabled
 *      in owner settings — else a graceful FALLBACK (no provider call),
 *   4. the operative modelId comes from the governed artifact (owner-confirmed),
 *   5. the provider adapter runs (server proxy / stub — never a key in the client),
 *   6. a provenance trace + usage record are written,
 *   7. an envelope is returned carrying family/id/version/provider/promptVersion/
 *      governanceVersion/confidence/riskScore/sourceContext/outputChecksum.
 *
 * Output is ADVISORY ONLY. The router applies nothing — no pricing, messaging,
 * calibration, accounting, or privacy action. The owner is the authority layer.
 * Enabling/disabling models + governance changes are owner-only (human) + audited.
 */
;(function (global) {
  'use strict';

  const SETTINGS = 'model_settings';
  const SETTINGS_ID = 'config';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function governance() { return global.AAA_GOVERNANCE; }
  function registry() { return global.AAA_MODEL_REGISTRY; }
  function mcp() { return global.AAA_MODEL_CALL_PROVENANCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function registeredAdapters() { return (global.AAA_MODEL_ADAPTERS || []).concat(Router._adapters); }

  function ck(o) { return mcp() && mcp().checksum ? mcp().checksum(o) : 'nochk'; }

  const Router = {
    SETTINGS: SETTINGS, _adapters: [],
    registerAdapter(a) { if (a && this._adapters.indexOf(a) === -1) this._adapters.push(a); return this; },
    adapterFor(modelKey) { const list = registeredAdapters(); for (const a of list) { try { if (a && a.supports && a.supports(modelKey)) return a; } catch (_) {} } return null; },

    /** The canonical governed model call. Never throws; always advisory. */
    async call(req) {
      const r = req || {};
      const reg = registry();
      if (!reg) return { ok: false, error: 'NO_REGISTRY' };
      const modelKey = r.modelKey || reg.modelForTask(r.taskType);
      const meta = modelKey ? reg.get(modelKey) : null;
      if (!meta) return { ok: false, error: 'UNKNOWN_MODEL', advisory: true };
      if (r.taskType && !reg.taskAllowed(modelKey, r.taskType)) return { ok: false, error: 'TASK_NOT_ALLOWED', advisory: true, message: r.taskType + ' is not an allowed task for ' + modelKey + '.' };

      // 2. Gateway gate — audits the attempt (denials included).
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'RUN_MODEL', origin: r.origin === 'ai' ? 'ai' : 'human', actor: r.actor || null, target: { type: 'model', id: modelKey }, detail: { taskType: r.taskType || null, agent: r.agent || null } });
      if (!auth.ok) return auth; // denied + audited

      // 3. Governed + active + enabled?
      const gov = await activeGoverned(modelKey);
      const enabled = await this.isEnabled(modelKey);
      if (!gov || !gov.content || !enabled) return await this._fallback(r, meta, modelKey, !gov ? 'MODEL_NOT_GOVERNED' : (!enabled ? 'MODEL_DISABLED' : 'NO_CONTENT'), auth.auditId);

      const content = typeof gov.content === 'string' ? safeParse(gov.content) : gov.content;
      const modelId = content && content.modelId;
      if (!modelId) return await this._fallback(r, meta, modelKey, 'NO_MODEL_ID', auth.auditId);

      // 5. Adapter (server proxy / stub — never a key client-side).
      const adapter = this.adapterFor(modelKey);
      if (!adapter) return await this._fallback(r, meta, modelKey, 'NO_ADAPTER', auth.auditId);
      const inv = await adapter.invoke({ modelKey: modelKey, modelId: modelId, runtime: content.runtime || null, taskType: r.taskType, variant: meta.variant, input: r.input, transport: r.transport });
      if (!inv.ok) return await this._fallback(r, meta, modelKey, inv.error || 'PROVIDER_UNAVAILABLE', auth.auditId, inv.latencyMs);

      // 6 + 7. Envelope + provenance + usage.
      const output = inv.kind === 'score' ? { score: inv.score } : { text: inv.text };
      const confidence = inv.kind === 'score' ? Math.round((inv.score != null ? inv.score : 0.5) * 100) : 70;
      const riskScore = reg.riskScoreFor(modelKey, r.taskType);
      let traceId = null, checksum = ck(output);
      if (mcp() && mcp().record) {
        const rec = await mcp().record({ modelKey: modelKey, modelId: modelId, provider: content.provider || meta.provider, runtime: content.runtime, taskType: r.taskType, agent: r.agent || null, input: r.input, output: output, confidence: confidence, riskScore: riskScore, promptVersion: (r.context && r.context.promptVersion) || r.governanceRef || null, governanceVersion: gov.versionId, sourceContext: r.context || null, ok: true, fallback: false, stub: !!(inv.raw && inv.raw.stub), latencyMs: inv.latencyMs });
        traceId = rec.traceId; checksum = rec.checksum;
      }
      return {
        ok: true, advisory: true, fallback: false, stub: !!(inv.raw && inv.raw.stub),
        modelFamily: meta.family, modelId: modelId, modelVersion: gov.versionId, provider: content.provider || meta.provider,
        promptVersion: (r.context && r.context.promptVersion) || null, governanceVersion: gov.versionId,
        confidence: confidence, riskScore: riskScore, sourceContext: r.context || null, outputChecksum: checksum,
        taskType: r.taskType, output: output, kind: inv.kind,
        ownerApprovalRequired: !!r.ownerApprovalRequired, needsOwnerApproval: !!r.ownerApprovalRequired,
        auditId: auth.auditId, provenanceTraceId: traceId, generatedAt: nowISO()
      };
    },

    /** Graceful fallback when a model is unavailable — neutral, advisory, audited. */
    async _fallback(r, meta, modelKey, reason, auditId, latencyMs) {
      const output = meta.variant === 'reward' ? { score: 0.5, note: 'neutral fallback' } : { text: '[unavailable] ' + modelKey + ' is not available (' + reason + '). No advisory output produced.' };
      let traceId = null, checksum = ck(output);
      if (mcp() && mcp().record) { const rec = await mcp().record({ modelKey: modelKey, modelId: null, provider: meta.provider, taskType: r.taskType, agent: r.agent || null, input: r.input, output: output, confidence: meta.variant === 'reward' ? 50 : 0, riskScore: 0, governanceVersion: null, sourceContext: r.context || null, ok: false, fallback: true, stub: false, latencyMs: latencyMs }); traceId = rec.traceId; checksum = rec.checksum; }
      return {
        ok: true, advisory: true, fallback: true, reason: reason,
        modelFamily: meta.family, modelId: null, modelVersion: null, provider: meta.provider,
        promptVersion: null, governanceVersion: null, confidence: meta.variant === 'reward' ? 50 : 0, riskScore: 0,
        sourceContext: r.context || null, outputChecksum: checksum, taskType: r.taskType, output: output, kind: meta.variant === 'reward' ? 'score' : 'text',
        ownerApprovalRequired: !!r.ownerApprovalRequired, auditId: auditId, provenanceTraceId: traceId, generatedAt: nowISO()
      };
    },

    // ---- governed provisioning (owner-only, two keys via the registry) -------
    /** File a model as a governed draft (artifactType 'model') + propose it. Owner
     *  still ACTIVATES it in the Governance Registry. AI-origin denied there. */
    async provision(modelKey, opts) {
      const o = opts || {}; const reg = registry(); const meta = reg && reg.get(modelKey);
      if (!meta) return { ok: false, error: 'UNKNOWN_MODEL' };
      if (!governance() || !governance().createDraft) return { ok: false, error: 'NO_GOVERNANCE' };
      const cand = reg.providerCandidates(modelKey);
      const content = { provider: meta.provider, runtime: o.runtime || cand.runtime, modelId: o.modelId || cand.modelId, allowedTasks: meta.allowedTasks, riskTier: meta.riskTier, ownerApproved: false, verifiedId: !!o.verifiedId };
      const draft = await governance().createDraft('model', modelKey, content, { actor: o.actor || null, origin: o.origin, notes: o.notes || ('Nemotron adapter: ' + meta.label + (content.verifiedId ? '' : ' — VERIFY modelId before activation')) });
      if (!draft.ok) return draft;
      const prop = await governance().propose(draft.version.id, { actor: o.actor || null, origin: o.origin });
      if (!prop.ok) return prop;
      return { ok: true, governanceVersionId: draft.version.id, content: content, note: 'Filed as a governance draft + proposed. Confirm the modelId, then approve + activate in the Governance Registry to enable calls.' };
    },

    // ---- owner-only enablement settings --------------------------------------
    async settings() { const r = await data().get(SETTINGS, SETTINGS_ID); return (mine(r) && r) ? r : { id: SETTINGS_ID, workspaceId: ws(), enabled: {} }; },
    async isEnabled(modelKey) { const s = await this.settings(); return !!(s.enabled && s.enabled[modelKey]); },
    async setEnabled(modelKey, on, opts) {
      const o = opts || {};
      if (!registry() || !registry().get(modelKey)) return { ok: false, error: 'UNKNOWN_MODEL' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'MANAGE_MODEL_SETTINGS', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'model_settings', id: modelKey }, detail: { enabled: !!on } });
      if (!auth.ok) return auth;
      const s = await this.settings();
      const enabled = Object.assign({}, s.enabled || {}); enabled[modelKey] = !!on;
      const rec = { id: SETTINGS_ID, workspaceId: ws(), enabled: enabled, updatedAt: nowISO(), updatedBy: o.actor || null };
      await data().put(SETTINGS, SETTINGS_ID, rec);
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(SETTINGS, SETTINGS_ID, rec); } catch (_) {}
      return { ok: true, modelKey: modelKey, enabled: !!on, auditId: auth.auditId };
    },

    /** Status for the governance UI: governed?/active?/enabled?/metrics. */
    async status(modelKey) {
      const gov = await activeGoverned(modelKey);
      const enabled = await this.isEnabled(modelKey);
      const metrics = mcp() && mcp().metrics ? await mcp().metrics(modelKey) : null;
      const content = gov && gov.content ? (typeof gov.content === 'string' ? safeParse(gov.content) : gov.content) : null;
      return { modelKey: modelKey, governed: !!gov, governanceVersion: gov ? gov.versionId : null, enabled: enabled, modelId: content ? content.modelId : null, runtime: content ? content.runtime : null, verifiedId: content ? !!content.verifiedId : false, metrics: metrics };
    }
  };

  async function activeGoverned(modelKey) {
    try { if (governance() && governance().getActive) { const v = await governance().getActive('model', modelKey); if (v) return { versionId: v.id, content: v.content }; } } catch (_) {}
    return null;
  }
  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

  global.AAA_GOVERNED_MODEL_ROUTER = Router;
})(typeof window !== 'undefined' ? window : this);
