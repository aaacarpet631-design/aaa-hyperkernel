/*
 * AAA App Mode — two apps inside one: Field Mode and Executive Mode.
 *
 * Field Mode (crews): everything starts from MEASURE. Executive Mode (owner):
 * everything starts from "what should I focus on?". This controller owns the
 * current mode, the default (role-aware, but field-first — the field tech's
 * money action is one tap away), the bottom-nav spec per mode, and the landing
 * tab. Mode persists to AAA_CONFIG so the choice sticks. Pure + deterministic.
 */
;(function (global) {
  'use strict';

  function installPolishStylesheet() {
    if (!global.document) return;
    if (global.document.getElementById('aaa-ui-polish-css')) return;
    const link = global.document.createElement('link');
    link.id = 'aaa-ui-polish-css';
    link.rel = 'stylesheet';
    link.href = '/css/ui-polish.css';
    global.document.head.appendChild(link);
  }
  installPolishStylesheet();

  function cfg() { return global.AAA_CONFIG || {}; }
  function rbac() { return global.AAA_RBAC; }
  function events() { return global.AAA_EVENTS; }

  const MODES = ['field', 'executive'];
  const NAV = {
    field: [
      { tab: 'measure', icon: '📐', label: 'Measure' },
      { tab: 'jobs', icon: '🗂', label: 'Jobs' },
      { tab: 'chat', icon: '💬', label: 'Chat' },
      { tab: 'more', icon: '⋯', label: 'More' }
    ],
    executive: [
      { tab: 'focus', icon: '🛰', label: 'Command' },
      { tab: 'jobs', icon: '🗂', label: 'Jobs' },
      { tab: 'chat', icon: '💬', label: 'Chat' },
      { tab: 'business', icon: '📊', label: 'Business' }
    ]
  };
  const LANDING = { field: 'measure', executive: 'focus' };

  function role() { return rbac() && rbac().role ? rbac().role() : 'owner'; }

  const AppMode = {
    MODES: MODES.slice(),

    /** Default mode: a stored choice wins; otherwise field-first for everyone
     *  (a crew is always field; the owner lands in field but can switch). */
    defaultMode() {
      const stored = cfg().flag ? cfg().flag('appMode', null) : (cfg().appMode || null);
      if (MODES.indexOf(stored) !== -1) return stored;
      return role() === 'crew' ? 'field' : 'field';
    },

    get() { return this.defaultMode(); },

    /** Set the active mode (persisted). Emits appmode.changed. */
    set(mode) {
      if (MODES.indexOf(mode) === -1) return { ok: false, error: 'UNKNOWN_MODE' };
      if (cfg().set) cfg().set({ appMode: mode });
      try { if (events()) events().emit('appmode.changed', { mode: mode }); } catch (_) {}
      return { ok: true, mode: mode };
    },

    toggle() { return this.set(this.get() === 'field' ? 'executive' : 'field'); },

    /** Bottom-nav spec for a mode (defaults to current). */
    navItems(mode) { return (NAV[mode || this.get()] || NAV.field).map(function (x) { return Object.assign({}, x); }); },

    /** Landing tab for a mode (defaults to current). */
    landingTab(mode) { return LANDING[mode || this.get()] || 'measure'; },

    /** Is a tab part of the given mode's nav? (used to validate deep links) */
    hasTab(tab, mode) { return this.navItems(mode).some(function (n) { return n.tab === tab; }); }
  };

  global.AAA_APP_MODE = AppMode;
})(typeof window !== 'undefined' ? window : this);
