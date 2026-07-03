/*
 * AAA Tenant Guard — the workspace boundary as POLICY, not just a filter.
 *
 * Every store read in this codebase already filters by workspaceId; what was
 * missing is the module that REFUSES cross-tenant work outright. The guard is
 * pure and read-only: it judges, it never mutates.
 *
 *   activeTenant()            the workspace this session is allowed to touch
 *   checkRecord(rec)          one record: same tenant (or legacy untagged)?
 *   checkRecords(list)        many records; names every violator
 *   guardContext(ctx)         a mission/task context: any foreign workspaceId
 *                             anywhere in it → TENANT_BOUNDARY (deep scan)
 *
 * Legacy records with no workspaceId are treated as local-tenant (the same
 * grandfathering every store applies) — but a PRESENT, DIFFERENT workspaceId
 * is always a refusal. There is no override flag: crossing tenants requires
 * changing the active workspace, on purpose, in config.
 */
;(function (global) {
  'use strict';

  const MAX_DEPTH = 6; // deep enough for any real context; guards against cycles

  function cfg() { return global.AAA_CONFIG || {}; }
  function ws() { return cfg().workspaceId || 'default'; }

  function findForeign(value, path, depth, out) {
    if (out.length >= 20 || value == null || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) findForeign(value[i], path + '[' + i + ']', depth + 1, out);
      return;
    }
    if (typeof value !== 'object') return;
    if (typeof value.workspaceId === 'string' && value.workspaceId !== ws()) {
      out.push({ path: path ? path + '.workspaceId' : 'workspaceId', workspaceId: value.workspaceId });
    }
    for (const k in value) {
      if (k === 'workspaceId') continue;
      findForeign(value[k], path ? path + '.' + k : k, depth + 1, out);
    }
  }

  const TenantGuard = {
    activeTenant: function () { return ws(); },

    /** One record: ok when it belongs to the active tenant (or is legacy-untagged). */
    checkRecord: function (rec) {
      if (rec == null || typeof rec !== 'object') return { ok: true, note: 'no record' };
      if (rec.workspaceId == null || rec.workspaceId === ws()) return { ok: true };
      return { ok: false, error: 'TENANT_BOUNDARY', workspaceId: rec.workspaceId, active: ws() };
    },

    /** Many records; every violator is named (never a silent partial pass). */
    checkRecords: function (list) {
      const violations = [];
      (Array.isArray(list) ? list : []).forEach(function (rec, i) {
        if (rec && typeof rec === 'object' && rec.workspaceId != null && rec.workspaceId !== ws()) {
          violations.push({ index: i, id: rec.id || null, workspaceId: rec.workspaceId });
        }
      });
      return violations.length ? { ok: false, error: 'TENANT_BOUNDARY', violations: violations, active: ws() } : { ok: true, checked: (list || []).length };
    },

    /**
     * Deep-scan a mission/task context for ANY foreign workspaceId. This is
     * what stops "merge tenant A's pricing into tenant B" from ever reaching
     * an agent: the mission is refused before a model sees it.
     */
    guardContext: function (context) {
      if (context == null) return { ok: true };
      const foreign = [];
      findForeign(context, '', 0, foreign);
      return foreign.length ? { ok: false, error: 'TENANT_BOUNDARY', foreign: foreign, active: ws() } : { ok: true };
    }
  };

  global.AAA_TENANT_GUARD = TenantGuard;
})(typeof window !== 'undefined' ? window : this);
