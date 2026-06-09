/*
 * AAA Governance Registry — the versioned, human-gated registry of record for
 * every GOVERNED artifact the AI org runs on: prompts, models, templates,
 * policies, and calibrations.
 *
 * Mission rule (rule 7): every registry is versioned, and no version goes ACTIVE
 * without a human approval. This module is the deterministic chokepoint for that
 * lifecycle:
 *
 *   createDraft  → draft        (the only API that accepts new content)
 *   propose      → proposed     (draft → proposed)
 *   approve      → approved     (proposed → approved; records approvedBy)
 *   activate     → active       (approved → active; prior active → deprecated)
 *   rollback     → active (new) (revert to a prior version; prior active → rolled_back)
 *   deprecate    → deprecated    (retire an active/approved version)
 *
 * Hard rules (enforced by code):
 *   - Append-only: every version is its own immutable document. A transition
 *     writes a NEW status + metadata; it NEVER rewrites a version's content or
 *     checksum (no silent mutation of an approved version).
 *   - Every mutating call routes through the gateway (GOVERN_REGISTRY, human-only
 *     + audited). AI and non-owners are blocked; each version records its
 *     governing action's auditRef.
 *   - Tamper-evident: each version's checksum chains the previous version's
 *     checksum; verifyChecksumChain() recomputes the whole lineage and reports
 *     any break.
 *   - Owner-only collection (financial), enforced server-side by Firestore rules.
 *   - Null-tolerant throughout: malformed/legacy rows degrade, never throw.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'governance_versions';
  const TYPES = ['prompt', 'model', 'template', 'policy', 'calibration'];
  const STATUSES = ['draft', 'proposed', 'approved', 'active', 'deprecated', 'rolled_back'];
  // Allowed forward transitions (rollback/deprecate handled explicitly).
  const NEXT = { draft: ['proposed', 'deprecated'], proposed: ['approved', 'deprecated'], approved: ['active', 'deprecated'], active: [], deprecated: [], rolled_back: [] };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function keyOf(artifactType, name) { return String(artifactType) + '::' + String(name); }

  // Deterministic, dependency-free content hash (cyrb53 → 14-hex-char digest).
  // Not a cryptographic primitive — it is a tamper-EVIDENCE checksum for the
  // version chain (the real security boundary is the Firestore rules + the
  // append-only/audited write path). Stable across runs for identical input.
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return ('0000000000000' + n.toString(16)).slice(-14);
  }
  // Canonical, stable serialization of content (object keys sorted) so the
  // checksum is independent of property order.
  function canonical(v) {
    if (v == null) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  // The chained checksum binds content to its lineage position + predecessor.
  function checksumFor(rec, prevChecksum) {
    return cyrb53(rec.artifactType + '|' + rec.name + '|' + rec.version + '|' + canonical(rec.content) + '|' + (prevChecksum || ''), 0x9e37);
  }

  const Registry = {
    COLLECTION: COLLECTION, TYPES: TYPES, STATUSES: STATUSES,

    // ---- create (the ONLY content-accepting API) -----------------------
    /**
     * Create a new DRAFT version of an artifact. Audited (GOVERN_REGISTRY).
     * The new version chains onto the artifact's latest version checksum.
     */
    async createDraft(artifactType, name, content, opts) {
      const o = opts || {};
      if (TYPES.indexOf(artifactType) === -1) return { ok: false, error: 'BAD_ARTIFACT_TYPE' };
      if (!name) return { ok: false, error: 'NAME_REQUIRED' };
      return this._gated('create_draft', keyOf(artifactType, name), o, async (auditId) => {
        const history = await this.listHistory(artifactType, name);
        const prev = history.length ? history[0] : null;           // newest
        const version = (prev ? prev.version : 0) + 1;
        const rec = {
          id: ids() ? ids().createId('gov') : 'gov_' + Date.now(), workspaceId: ws(),
          artifactType: artifactType, name: name, key: keyOf(artifactType, name), version: version,
          status: 'draft', content: content != null ? content : null,
          prevChecksum: prev ? prev.checksum : null, checksum: null,
          createdBy: o.actor || null, approvedBy: null,
          createdAt: nowISO(), updatedAt: nowISO(), proposedAt: null, approvedAt: null, activatedAt: null, deprecatedAt: null,
          rollbackFrom: null, rollbackTo: null, auditRef: auditId, notes: o.notes || null
        };
        rec.checksum = checksumFor(rec, rec.prevChecksum);
        await put(rec);
        return rec;
      });
    },

    // ---- lifecycle transitions (no content ever accepted) --------------
    async propose(versionId, opts) { return this._transition(versionId, 'proposed', opts); },
    async approve(versionId, opts) { return this._transition(versionId, 'approved', opts); },

    /** Activate an APPROVED version; the prior active version is deprecated. */
    async activate(versionId, opts) {
      const o = opts || {};
      const v = await this.get(versionId);
      if (!v) return { ok: false, error: 'NOT_FOUND' };
      if (v.status !== 'approved') return { ok: false, error: 'NOT_APPROVED', message: 'Only an approved version can be activated.' };
      return this._gated('activate', versionId, o, async (auditId) => {
        const current = await this.getActive(v.artifactType, v.name);
        if (current && current.id !== v.id) await put(Object.assign({}, current, { status: 'deprecated', deprecatedAt: nowISO(), updatedAt: nowISO() }));
        const rec = Object.assign({}, v, { status: 'active', activatedAt: nowISO(), updatedAt: nowISO(), auditRef: auditId });
        await put(rec);
        return rec;
      });
    },

    /** Manually retire an active/approved version (no replacement). */
    async deprecate(versionId, opts) { return this._transition(versionId, 'deprecated', opts); },

    /**
     * Roll an artifact back to a prior version. Append-only + reversible:
     * creates a NEW active version cloning the target's content, marks the
     * current active version 'rolled_back'. Defaults to the version the current
     * active one superseded; pass opts.toVersionId to target a specific one.
     */
    async rollback(artifactType, name, opts) {
      const o = opts || {};
      const current = await this.getActive(artifactType, name);
      if (!current) return { ok: false, error: 'NOTHING_ACTIVE', message: 'No active version to roll back.' };
      const history = await this.listHistory(artifactType, name); // newest first
      let target = null;
      if (o.toVersionId) target = history.find((h) => h.id === o.toVersionId) || null;
      else target = history.filter((h) => h.id !== current.id && (h.status === 'deprecated' || h.status === 'rolled_back' || h.status === 'approved')).sort((a, b) => b.version - a.version)[0] || null;
      if (!target) return { ok: false, error: 'NO_TARGET', message: 'No prior version to roll back to.' };
      return this._gated('rollback', keyOf(artifactType, name), o, async (auditId) => {
        await put(Object.assign({}, current, { status: 'rolled_back', updatedAt: nowISO() }));
        const prev = history[0];
        const rec = {
          id: ids() ? ids().createId('gov') : 'gov_' + Date.now(), workspaceId: ws(),
          artifactType: artifactType, name: name, key: keyOf(artifactType, name), version: (prev ? prev.version : current.version) + 1,
          status: 'active', content: target.content,
          prevChecksum: prev ? prev.checksum : null, checksum: null,
          createdBy: o.actor || null, approvedBy: target.approvedBy || current.approvedBy || null,
          createdAt: nowISO(), updatedAt: nowISO(), proposedAt: nowISO(), approvedAt: nowISO(), activatedAt: nowISO(), deprecatedAt: null,
          rollbackFrom: current.id, rollbackTo: target.id, auditRef: auditId,
          notes: 'Rollback of v' + current.version + ' to v' + target.version + (o.notes ? ' — ' + o.notes : '')
        };
        rec.checksum = checksumFor(rec, rec.prevChecksum);
        await put(rec);
        return rec;
      });
    },

    // ---- reads ----------------------------------------------------------
    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },
    async list(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.artifactType) all = all.filter((v) => v.artifactType === f.artifactType);
      if (f.name) all = all.filter((v) => v.name === f.name);
      if (f.status) all = all.filter((v) => v.status === f.status);
      return all.sort(byVersionDesc);
    },
    async getActive(artifactType, name) { return (await this.list({ artifactType: artifactType, name: name, status: 'active' }))[0] || null; },
    async listActive() { return (await this.list({ status: 'active' })); },
    async listHistory(artifactType, name) { return this.list({ artifactType: artifactType, name: name }); },

    /** Distinct artifacts (one row per key) with their active/latest status. */
    async artifacts() {
      const all = await this.list();
      const by = {};
      all.forEach((v) => { const g = by[v.key] || (by[v.key] = { key: v.key, artifactType: v.artifactType, name: v.name, versions: 0, active: null, latest: null }); g.versions++; if (v.status === 'active') g.active = v; if (!g.latest || v.version > g.latest.version) g.latest = v; });
      return Object.keys(by).map((k) => by[k]).sort((a, b) => a.key.localeCompare(b.key));
    },

    /**
     * Recompute the checksum chain for an artifact's full lineage and report any
     * break (a content edit, a mis-chained prevChecksum, or a version gap).
     */
    async verifyChecksumChain(artifactType, name) {
      const chain = (await this.listHistory(artifactType, name)).slice().sort((a, b) => a.version - b.version); // oldest first
      const breaks = [];
      let prevChecksum = null;
      chain.forEach((v, i) => {
        const expected = checksumFor(v, prevChecksum);
        if (v.checksum !== expected) breaks.push({ id: v.id, version: v.version, reason: 'checksum_mismatch', expected: expected, stored: v.checksum });
        else if ((v.prevChecksum || null) !== (prevChecksum || null)) breaks.push({ id: v.id, version: v.version, reason: 'chain_break', expectedPrev: prevChecksum, storedPrev: v.prevChecksum || null });
        if (i > 0 && v.version !== chain[i - 1].version + 1) breaks.push({ id: v.id, version: v.version, reason: 'version_gap' });
        prevChecksum = v.checksum;
      });
      return { ok: breaks.length === 0, length: chain.length, breaks: breaks };
    },

    // ---- internals ------------------------------------------------------
    async _transition(versionId, to, opts) {
      const o = opts || {};
      const v = await this.get(versionId);
      if (!v) return { ok: false, error: 'NOT_FOUND' };
      if (to === 'deprecated') { if (v.status !== 'active' && v.status !== 'approved') return { ok: false, error: 'BAD_TRANSITION', message: 'Cannot deprecate from ' + v.status + '.' }; }
      else if ((NEXT[v.status] || []).indexOf(to) === -1) return { ok: false, error: 'BAD_TRANSITION', message: 'Cannot go ' + v.status + ' → ' + to + '.' };
      return this._gated(to, versionId, o, async (auditId) => {
        const patch = { status: to, updatedAt: nowISO(), auditRef: auditId };
        if (to === 'proposed') patch.proposedAt = nowISO();
        if (to === 'approved') { patch.approvedAt = nowISO(); patch.approvedBy = o.actor || null; }
        if (to === 'deprecated') patch.deprecatedAt = nowISO();
        // Content + checksum are intentionally NOT touched (no silent mutation).
        const rec = Object.assign({}, v, patch);
        await put(rec);
        return rec;
      });
    },

    /**
     * Route a governance mutation through the gateway for the authorization
     * decision (human-only + RBAC + audit), THEN run the write stamped with the
     * resulting auditRef. The gateway records the allowed/denied intent and
     * returns its audit id; a denial (AI or non-owner) short-circuits here.
     */
    async _gated(op, targetId, o, mutate) {
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: 'GOVERN_REGISTRY', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'governance_version', id: targetId }, detail: { op: op }
      });
      if (!res.ok) return res;                 // FORBIDDEN / AI_NOT_PERMITTED (audited)
      const version = await mutate(res.auditId);
      return { ok: true, version: version, auditId: res.auditId };
    }
  };

  function byVersionDesc(a, b) { return (b.version || 0) - (a.version || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  async function put(rec) {
    await data().put(COLLECTION, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COLLECTION, rec.id, rec); } catch (_) {}
  }

  global.AAA_GOVERNANCE = Registry;
})(typeof window !== 'undefined' ? window : this);
