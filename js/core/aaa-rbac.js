/*
 * AAA RBAC — Role-Based Access Control (the authority every screen queries).
 *
 * Three roles for a family flooring business:
 *   - owner   : full access (sales, growth, money, everything)
 *   - manager : production + scheduling + crew + most data; NOT money internals
 *   - crew    : field work only — jobs assigned to them, measurements, photos,
 *               closure checklist. NEVER sees margins, costs, accounting, or
 *               business-wide financials.
 *
 * This is a deterministic permission matrix, not a flag. `can(permission)` is
 * the single question the UI and the Runtime Gateway ask. The active role is
 * persisted per-device (AAA_CONFIG) and, when cloud auth is on, should match
 * the member's role in Firestore (workspaces/{ws}/members/{uid}.role) — the
 * Firestore rules enforce the same matrix server-side so a tampered client
 * still can't read what it shouldn't.
 *
 * Fail-closed: an unknown role or unknown permission returns false.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function events() { return global.AAA_EVENTS; }

  const ROLES = ['owner', 'manager', 'crew'];

  // Permission catalog. Grouped for readability; the matrix below grants them.
  const PERMISSIONS = {
    // Visibility of money/cost internals (the crew-sensitive ones).
    VIEW_FINANCIALS: 'See revenue, profit, accounting, business dashboard',
    VIEW_MARGINS: 'See labor cost, material cost, margin on quotes',
    VIEW_PRICING_RATES: 'See/edit the rate card',
    // Quotes & jobs
    CREATE_QUOTE: 'Create a quote / estimate',
    APPROVE_QUOTE: 'Approve / finalize a customer price',
    EDIT_JOB: 'Edit job details, schedule, assignments',
    CLOSE_JOB: 'Close out a completed job',
    VIEW_ALL_JOBS: 'See every job (not just assigned)',
    // Customers
    EDIT_CUSTOMER: 'Create / edit customer records',
    // Field work (crew always has these)
    CAPTURE_MEASUREMENT: 'Capture measurements',
    CAPTURE_PHOTO: 'Capture job photos',
    COMPLETE_CHECKLIST: 'Complete the closure checklist',
    // AI & admin
    RUN_AI_AGENTS: 'Run AI agents / meetings',
    MANAGE_AUTOMATION: 'Turn automation/auto-pilot on/off',
    MANAGE_SETTINGS: 'Cloud settings, members, integrations',
    MANAGE_CREW: 'Manage employees / crew / tools',
    VIEW_AUDIT_LOG: 'View the audit trail'
  };

  // Role → granted permissions. Owner gets everything by construction.
  const MATRIX = {
    owner: Object.keys(PERMISSIONS),
    manager: [
      'CREATE_QUOTE', 'APPROVE_QUOTE', 'EDIT_JOB', 'CLOSE_JOB', 'VIEW_ALL_JOBS',
      'EDIT_CUSTOMER', 'CAPTURE_MEASUREMENT', 'CAPTURE_PHOTO', 'COMPLETE_CHECKLIST',
      'RUN_AI_AGENTS', 'MANAGE_AUTOMATION', 'MANAGE_CREW', 'VIEW_AUDIT_LOG',
      'VIEW_PRICING_RATES'
      // NOTE: no VIEW_FINANCIALS / VIEW_MARGINS — managers run production, not the books.
    ],
    crew: [
      'CAPTURE_MEASUREMENT', 'CAPTURE_PHOTO', 'COMPLETE_CHECKLIST', 'CREATE_QUOTE'
      // Crew can draft a quote from measurements but cannot APPROVE_QUOTE,
      // never sees margins/financials, can't edit customers or close jobs.
    ]
  };

  const RBAC = {
    ROLES: ROLES,
    PERMISSIONS: PERMISSIONS,

    /** Current role for this device/session. Defaults to 'owner' for a
     *  single-operator install; multi-user installs set it from the member doc. */
    role() {
      const r = cfg().flag ? cfg().flag('role', null) : null;
      return ROLES.indexOf(r) !== -1 ? r : 'owner';
    },

    /** Set the active role (persisted). Emits 'rbac.changed'. */
    setRole(role) {
      if (ROLES.indexOf(role) === -1) return { ok: false, error: 'UNKNOWN_ROLE' };
      if (cfg().set) cfg().set({ role: role });
      if (events()) events().emit('rbac.changed', { role: role });
      return { ok: true, role: role };
    },

    /** The single authorization question. Fail-closed. */
    can(permission) {
      if (!permission || !PERMISSIONS[permission]) return false; // unknown perm → deny
      const grants = MATRIX[this.role()];
      return Array.isArray(grants) && grants.indexOf(permission) !== -1;
    },

    /** All permissions for a role (for settings UI / debugging). */
    grantsFor(role) {
      return (MATRIX[role] || []).slice();
    },

    /** Human label for a role. */
    label(role) {
      return ({ owner: 'Owner', manager: 'Crew Manager', crew: 'Crew' })[role || this.role()] || 'Unknown';
    },

    /** Guard helper: returns a denial object when not allowed, else null. */
    require(permission) {
      return this.can(permission) ? null : { ok: false, error: 'FORBIDDEN', permission: permission, role: this.role() };
    }
  };

  global.AAA_RBAC = RBAC;
})(typeof window !== 'undefined' ? window : this);
