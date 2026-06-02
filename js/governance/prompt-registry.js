/*
 * AAA Prompt Registry — a governed, versioned, tamper-evident store for agent
 * prompts/processes. It is the safe registry the Phase-4 pipeline applies into:
 * approved proposals create new ACTIVE versions; history is append-only and
 * hash-chained; rollback adds a new version (never deletes); every transition is
 * audited. No autonomy — apply/approve/rollback are Admin(owner)-only.
 *
 * Runtime: agents call resolve(agentId, fallback) and get the active version
 * when one exists, otherwise their existing hardcoded prompt — so nothing breaks
 * until an Admin approves and applies a version.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function rbac() { return global.AAA_RBAC; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function learning() { return global.AAA_GOVERNANCE_LEARNING; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const ENTRIES = 'gov_prompt_registry';
  const VPROPS = 'gov_prompt_version_proposals';

  // ---- tamper-evident checksum (chained across versions) --------------------
  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
  function checksum(text, version, prevChecksum) {
    const s = version + '|' + (prevChecksum || '0') + '|' + String(text == null ? '' : text);
    return fnv(s) + fnv('promptreg:' + s + '|' + s.length);
  }

  async function audit(type, payload) { try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {} return null; }
  function actor(opts) { opts = opts || {}; const uid = cfg().firebaseUid || (cfg().flag ? cfg().flag('firebaseUid', null) : null); return { id: opts.actorId || uid || 'local-operator', role: (rbac() && rbac().role) ? rbac().role() : 'unknown' }; }
  function canApprove() { return !!(rbac() && rbac().can && rbac().can('OVERRIDE_AI_DECISION')); }
  function scrub(s) { return (learning() && learning().scrubPII) ? learning().scrubPII(s) : s; }
  function newId(p) { return (global.AAA_ID_FACTORY && global.AAA_ID_FACTORY.createId) ? global.AAA_ID_FACTORY.createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)); }

  async function getEntry(agentId) { return (data() && data().get) ? data().get(ENTRIES, agentId) : null; }
  async function putEntry(e) { if (data() && data().put) await data().put(ENTRIES, e.agentId, e); return e; }
  async function getProp(id) { return (data() && data().get) ? data().get(VPROPS, id) : null; }
  async function putProp(p) { if (data() && data().put) await data().put(VPROPS, p.proposalId, p); return p; }

  const Registry = {
    ENTRIES: ENTRIES, checksum: checksum,

    // ---- reads -------------------------------------------------------------
    async entry(agentId) { return getEntry(agentId); },
    async getCurrent(agentId) {
      const e = await getEntry(agentId);
      if (!e || !e.versions || !e.versions.length) return null;
      const v = e.versions.filter(function (x) { return x.version === e.currentVersion; })[0];
      return v ? v.text : null;
    },
    async getVersion(agentId, version) {
      const e = await getEntry(agentId);
      return e ? (e.versions || []).filter(function (x) { return x.version === version; })[0] || null : null;
    },
    async history(agentId) { const e = await getEntry(agentId); return e ? (e.versions || []).slice().sort(function (a, b) { return a.version - b.version; }) : []; },
    async list() { return (data() && data().list) ? data().list(ENTRIES) : []; },
    async proposals() { return (data() && data().list) ? data().list(VPROPS) : []; },

    /** Runtime: active version text, or the agent's hardcoded fallback. Never throws. */
    async resolve(agentId, fallback) {
      try { const cur = await this.getCurrent(agentId); return (cur != null && cur !== '') ? cur : fallback; } catch (_) { return fallback; }
    },

    // ---- governance flow ---------------------------------------------------
    /** Propose a new version (anyone may propose; not yet applied). */
    async proposeVersion(agentId, proposedText, metadata) {
      metadata = metadata || {};
      if (!agentId || proposedText == null) return { ok: false, error: 'INVALID' };
      const who = actor(metadata);
      const prop = {
        proposalId: newId('vprop'), agentId: agentId, agentType: metadata.agentType || null, name: metadata.name || 'system',
        text: proposedText, reason: metadata.reason || null, evidenceCases: Array.isArray(metadata.evidenceCases) ? metadata.evidenceCases : [],
        sourceProposalId: metadata.sourceProposalId || null, checklistConfirmed: !!metadata.checklistConfirmed, rollbackNote: metadata.rollbackNote || null,
        status: 'proposed', createdBy: who.id, createdAt: now()
      };
      await putProp(prop);
      await audit('prompt_version_proposed', { proposalId: prop.proposalId, agentId: agentId, sourceProposalId: prop.sourceProposalId, actorId: who.id, actorRole: who.role, at: prop.createdAt });
      return { ok: true, proposal: prop };
    },

    /** Approve a proposed version (Admin only). */
    async approveVersion(proposalId, opts) {
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const prop = await getProp(proposalId);
      if (!prop) return { ok: false, error: 'NOT_FOUND' };
      if (prop.status !== 'proposed') return { ok: false, error: 'BAD_TRANSITION', from: prop.status };
      const who = actor(opts);
      const upd = Object.assign({}, prop, { status: 'approved', approvedBy: who.id, approvedAt: now() });
      await putProp(upd);
      await audit('prompt_version_approved', { proposalId: proposalId, agentId: prop.agentId, actorId: who.id, actorRole: who.role, at: now() });
      return { ok: true, proposal: upd };
    },

    /**
     * Apply an APPROVED version (Admin only). Requires checklist confirmation +
     * rollback note. Creates a new active version (prior current → archived),
     * chained by checksum, and records the audit ref on the version.
     */
    async applyVersion(proposalId, opts) {
      opts = opts || {};
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const prop = await getProp(proposalId);
      if (!prop) return { ok: false, error: 'NOT_FOUND' };
      if (prop.status !== 'approved') return { ok: false, error: 'NOT_APPROVED', from: prop.status };
      if (opts.checklistConfirmed !== true && prop.checklistConfirmed !== true) return { ok: false, error: 'CHECKLIST_REQUIRED' };
      const rollbackNote = opts.rollbackNote || prop.rollbackNote;
      if (!rollbackNote || String(rollbackNote).trim().length < 5) return { ok: false, error: 'ROLLBACK_NOTE_REQUIRED' };

      const who = actor(opts);
      const entry = await getEntry(prop.agentId);
      const versions = entry ? entry.versions.slice() : [];
      const prevChecksum = versions.length ? versions[versions.length - 1].checksum : '0';
      const version = entry ? entry.currentVersion + 1 : 1;
      const cs = checksum(prop.text, version, prevChecksum);
      const auditEntry = await audit('prompt_version_applied', { agentId: prop.agentId, version: version, checksum: cs, prevChecksum: prevChecksum, proposalId: proposalId, sourceProposalId: prop.sourceProposalId || null, rollbackNote: String(rollbackNote).trim(), actorId: who.id, actorRole: who.role, at: now() });
      const auditRef = auditEntry ? auditEntry.id : null;
      const vrec = { version: version, text: prop.text, checksum: cs, prevChecksum: prevChecksum, status: 'active', createdBy: prop.createdBy, approvedBy: prop.approvedBy || who.id, createdAt: prop.createdAt, approvedAt: prop.approvedAt || now(), appliedAt: now(), proposalId: proposalId, sourceProposalId: prop.sourceProposalId || null, rollbackNote: String(rollbackNote).trim(), auditRef: auditRef };
      const archived = versions.map(function (v) { return v.status === 'active' ? Object.assign({}, v, { status: 'archived' }) : v; });
      const newEntry = entry
        ? Object.assign({}, entry, { currentVersion: version, status: 'active', versions: archived.concat([vrec]), approvedBy: vrec.approvedBy, approvedAt: vrec.approvedAt, updatedAt: now() })
        : { agentId: prop.agentId, agentType: prop.agentType || null, name: prop.name || 'system', currentVersion: version, status: 'active', createdBy: prop.createdBy, approvedBy: vrec.approvedBy, createdAt: now(), approvedAt: vrec.approvedAt, versions: [vrec] };
      await putEntry(newEntry);
      await putProp(Object.assign({}, prop, { status: 'applied', appliedVersion: version, appliedAt: now(), auditRef: auditRef }));
      return { ok: true, version: version, checksum: cs, auditRef: auditRef, entry: newEntry };
    },

    /**
     * Roll back to an earlier version (Admin only). Appends a NEW active version
     * carrying the target's text — history is never deleted.
     */
    async rollback(agentId, targetVersion, opts) {
      opts = opts || {};
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const entry = await getEntry(agentId);
      if (!entry) return { ok: false, error: 'NOT_FOUND' };
      const target = (entry.versions || []).filter(function (v) { return v.version === targetVersion; })[0];
      if (!target) return { ok: false, error: 'VERSION_NOT_FOUND' };
      const who = actor(opts);
      const versions = entry.versions.slice();
      const prevChecksum = versions[versions.length - 1].checksum;
      const version = entry.currentVersion + 1;
      const cs = checksum(target.text, version, prevChecksum);
      const auditEntry = await audit('prompt_version_rolled_back', { agentId: agentId, toVersion: targetVersion, newVersion: version, checksum: cs, reason: opts.reason || null, actorId: who.id, actorRole: who.role, at: now() });
      const vrec = { version: version, text: target.text, checksum: cs, prevChecksum: prevChecksum, status: 'active', rollbackOf: targetVersion, createdBy: who.id, approvedBy: who.id, createdAt: now(), appliedAt: now(), auditRef: auditEntry ? auditEntry.id : null };
      const archived = versions.map(function (v) { return v.status === 'active' ? Object.assign({}, v, { status: 'archived' }) : v; });
      const newEntry = Object.assign({}, entry, { currentVersion: version, status: 'rollback', versions: archived.concat([vrec]), updatedAt: now() });
      await putEntry(newEntry);
      return { ok: true, version: version, rolledBackTo: targetVersion, entry: newEntry };
    },

    // ---- tamper resistance -------------------------------------------------
    /** Recompute the checksum chain for an agent's version history. */
    async verify(agentId) {
      const e = await getEntry(agentId);
      if (!e) return { ok: true, length: 0 };
      const versions = (e.versions || []).slice().sort(function (a, b) { return a.version - b.version; });
      let prev = '0';
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        if (v.prevChecksum !== prev) return { ok: false, brokenAt: v.version, reason: 'PREV_MISMATCH' };
        if (v.checksum !== checksum(v.text, v.version, v.prevChecksum)) return { ok: false, brokenAt: v.version, reason: 'TAMPERED' };
        prev = v.checksum;
      }
      return { ok: true, length: versions.length };
    },

    /** Cross-check the registry's applied versions against the immutable ledger. */
    async verifyAgainstLedger(agentId) {
      const e = await getEntry(agentId);
      if (!e) return { ok: true, checked: 0 };
      const chain = (ledger() && ledger().chain) ? await ledger().chain() : [];
      const applied = chain.filter(function (x) { return (x.type === 'prompt_version_applied' || x.type === 'prompt_version_rolled_back') && x.payload && x.payload.agentId === agentId; });
      let checked = 0;
      for (const v of (e.versions || [])) {
        const led = applied.filter(function (x) { return (x.payload.version === v.version) || (x.payload.newVersion === v.version); })[0];
        if (led) {
          // Recompute from the STORED text and compare to the immutable ledger
          // checksum — catches a text tamper even if the stored checksum was
          // also altered to match.
          const recomputed = checksum(v.text, v.version, v.prevChecksum);
          if (led.payload.checksum !== recomputed) return { ok: false, brokenAt: v.version, reason: 'LEDGER_MISMATCH' };
          checked++;
        }
      }
      return { ok: true, checked: checked };
    },

    // ---- export (PII-stripped evidence) ------------------------------------
    async export(agentId, opts) {
      const entries = agentId ? [await getEntry(agentId)].filter(Boolean) : await this.list();
      const props = (await this.proposals()).filter(function (p) { return p.status === 'approved' || p.status === 'applied'; })
        .map(function (p) { return Object.assign({}, p, { reason: scrub(p.reason) }); });
      const registry = entries.map(function (e) {
        return { agentId: e.agentId, agentType: e.agentType, name: e.name, currentVersion: e.currentVersion, status: e.status,
          versions: (e.versions || []).map(function (v) { return { version: v.version, checksum: v.checksum, prevChecksum: v.prevChecksum, status: v.status, approvedBy: v.approvedBy, appliedAt: v.appliedAt, rollbackOf: v.rollbackOf || null, auditRef: v.auditRef, text: scrub(v.text) }; }) };
      });
      const who = actor(opts);
      await audit('prompt_registry_exported', { agentId: agentId || 'all', entries: registry.length, proposals: props.length, actorId: who.id, at: now() });
      return { ok: true, json: { registry: registry, approvedProposals: props } };
    },

    // ---- adapter for the Phase-4 prompt-change pipeline ---------------------
    // getPrompt/apply/rollback are what AAA_PROMPT_PIPELINE calls. apply maps a
    // Phase-4 (already Admin-approved) proposal into propose→approve→apply,
    // carrying its approval context and recording the source proposal id.
    adapter() {
      const self = this;
      return {
        getPrompt: function (agentId) { /* sync best-effort */ return null; },
        getPromptAsync: function (agentId) { return self.getCurrent(agentId); },
        apply: async function (agentId, text, p4) {
          const md = { agentType: p4 && p4.agentId, name: 'system', reason: p4 && p4.reason, evidenceCases: (p4 && p4.evidenceCases) || [], sourceProposalId: p4 && p4.proposalId, checklistConfirmed: !!(p4 && p4.checklistConfirmed), rollbackNote: (p4 && p4.rollbackNote) || 'From approved proposal.', actorId: p4 && p4.approvedBy };
          const prop = await self.proposeVersion(agentId, text, md);
          if (!prop.ok) return prop;
          const ap = await self.approveVersion(prop.proposal.proposalId, { actorId: md.actorId });
          if (!ap.ok) return ap;
          return self.applyVersion(prop.proposal.proposalId, { actorId: md.actorId, checklistConfirmed: true, rollbackNote: md.rollbackNote });
        },
        rollback: async function (agentId, _ignored, p4) {
          const e = await self.getEntry ? await getEntry(agentId) : null;
          if (!e || e.currentVersion <= 1) return { ok: false, error: 'NO_PRIOR_VERSION' };
          return self.rollback(agentId, e.currentVersion - 1, { actorId: p4 && p4.approvedBy, reason: 'rollback via proposal ' + (p4 && p4.proposalId) });
        }
      };
    }
  };

  global.AAA_PROMPT_REGISTRY = Registry;

  // Auto-wire as the Phase-4 pipeline's safe registry when both are present.
  try { if (global.AAA_PROMPT_PIPELINE && global.AAA_PROMPT_PIPELINE.registerRegistry) global.AAA_PROMPT_PIPELINE.registerRegistry(Registry.adapter()); } catch (_) {}
})(typeof window !== 'undefined' ? window : this);
