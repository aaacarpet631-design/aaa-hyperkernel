/*
 * AAA App Mode — Field and Executive operating modes.
 * Includes an additive intelligent command shell for navigation and operator context.
 * The shell never mutates business data and only activates existing UI controls.
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

    defaultMode() {
      const stored = cfg().flag ? cfg().flag('appMode', null) : (cfg().appMode || null);
      if (MODES.indexOf(stored) !== -1) return stored;
      return role() === 'crew' ? 'field' : 'field';
    },

    get() { return this.defaultMode(); },

    set(mode) {
      if (MODES.indexOf(mode) === -1) return { ok: false, error: 'UNKNOWN_MODE' };
      if (cfg().set) cfg().set({ appMode: mode });
      try { if (events()) events().emit('appmode.changed', { mode: mode }); } catch (_) {}
      updateIntelligenceStrip();
      return { ok: true, mode: mode };
    },

    toggle() { return this.set(this.get() === 'field' ? 'executive' : 'field'); },

    navItems(mode) { return (NAV[mode || this.get()] || NAV.field).map(function (x) { return Object.assign({}, x); }); },

    landingTab(mode) { return LANDING[mode || this.get()] || 'measure'; },

    hasTab(tab, mode) { return this.navItems(mode).some(function (n) { return n.tab === tab; }); }
  };

  global.AAA_APP_MODE = AppMode;

  const COMMANDS = [
    { group: 'Navigate', id: 'command', icon: '🛰', title: 'Open Command', detail: 'Owner focus, risks, priorities, and decisions', tag: 'Executive', run: function () { activateTab('focus'); } },
    { group: 'Navigate', id: 'measure', icon: '📐', title: 'Start Measurement', detail: 'Open Field Mode and begin the field capture workflow', tag: 'Field', run: function () { ensureMode('field'); activateTab('measure'); } },
    { group: 'Navigate', id: 'jobs', icon: '🗂', title: 'Open Jobs', detail: 'Review active work, attention items, and job details', tag: 'Work', run: function () { activateTab('jobs'); } },
    { group: 'Navigate', id: 'chat', icon: '💬', title: 'Ask HyperKernel', detail: 'Open the business copilot and focus the message box', tag: 'AI', run: function () { openChat(''); } },
    { group: 'Navigate', id: 'business', icon: '📊', title: 'Open Business', detail: 'Revenue, operations, and business intelligence', tag: 'Executive', run: function () { ensureMode('executive'); activateTab('business'); } },
    { group: 'Intelligence', id: 'mission', icon: '◈', title: 'Start a governed mission', detail: 'Create a precise objective with review and evidence built in', tag: 'Governed', run: function () { openChat('Create a governed mission for this objective: '); } },
    { group: 'Intelligence', id: 'briefing', icon: '☀', title: 'What needs attention?', detail: 'Ask for an honest owner briefing grounded in current data', tag: 'Brief', run: function () { openChat('What needs my attention right now? Prioritize by business impact and tell me what evidence supports each item.'); } },
    { group: 'Intelligence', id: 'agents', icon: '🤖', title: 'Open Agent Workforce', detail: 'Inspect continuous agents, health, jobs, and approvals', tag: 'Agents', run: function () { clickByText(['Agent Workforce', 'AI Team']); } },
    { group: 'Governance', id: 'approvals', icon: '✓', title: 'Open Approvals', detail: 'Review decisions waiting for human authority', tag: 'Human', run: function () { clickByText(['Approvals', 'Approval']); } },
    { group: 'Governance', id: 'mode', icon: '↔', title: 'Switch operating mode', detail: 'Move between Field and Executive workflows', tag: 'Mode', run: function () { AppMode.toggle(); activateTab(AppMode.landingTab()); } }
  ];

  let shellInstalled = false;
  let paletteOpen = false;
  let commandQuery = '';

  function textOf(node) { return String(node && node.textContent || '').replace(/\s+/g, ' ').trim(); }

  function findTab(tab) {
    const selectors = [
      '.aaa-tab[data-tab="' + tab + '"]',
      '[data-tab="' + tab + '"]',
      '[data-target="' + tab + '"]',
      '[aria-controls="' + tab + '"]'
    ];
    for (let i = 0; i < selectors.length; i += 1) {
      const node = global.document.querySelector(selectors[i]);
      if (node) return node;
    }
    const candidates = Array.from(global.document.querySelectorAll('button,a'));
    const label = ({ focus: 'command', measure: 'measure', jobs: 'jobs', chat: 'chat', business: 'business', more: 'more' })[tab] || tab;
    return candidates.find(function (node) { return textOf(node).toLowerCase() === label; }) || null;
  }

  function activateTab(tab) {
    const direct = findTab(tab);
    if (direct && typeof direct.click === 'function') { direct.click(); return true; }
    try {
      if (global.AAA_APP && typeof global.AAA_APP.openTab === 'function') { global.AAA_APP.openTab(tab); return true; }
      if (global.AAA_UI && typeof global.AAA_UI.openTab === 'function') { global.AAA_UI.openTab(tab); return true; }
    } catch (_) {}
    return false;
  }

  function ensureMode(mode) {
    if (AppMode.get() !== mode) AppMode.set(mode);
  }

  function clickByText(labels) {
    const wanted = labels.map(function (x) { return x.toLowerCase(); });
    const candidates = Array.from(global.document.querySelectorAll('button,a'));
    const exact = candidates.find(function (node) { return wanted.indexOf(textOf(node).toLowerCase()) !== -1; });
    const partial = candidates.find(function (node) {
      const t = textOf(node).toLowerCase();
      return wanted.some(function (label) { return t.indexOf(label.toLowerCase()) !== -1; });
    });
    const target = exact || partial;
    if (target && typeof target.click === 'function') { target.click(); return true; }
    activateTab('business');
    return false;
  }

  function openChat(seed) {
    activateTab('chat');
    global.setTimeout(function () {
      const input = global.document.querySelector('.cc-input, #chat-input, textarea[data-chat-input], input[data-chat-input]');
      if (!input) return;
      if (seed) {
        input.value = seed;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.focus();
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
    }, 80);
  }

  function runtimeStatus() {
    const online = global.navigator ? global.navigator.onLine !== false : true;
    const hermes = !!global.AAA_HERMES;
    const agentOS = !!global.AAA_AGENT_OS;
    const governance = !!(global.AAA_GOVERNANCE || global.AAA_RUNTIME_GATEWAY || global.AAA_DECISION_ENVELOPE);
    const workforce = !!global.AAA_WORKFORCE;
    let level = online ? 'ready' : 'offline';
    if (online && !(hermes || agentOS)) level = 'warning';
    return { online: online, hermes: hermes, agentOS: agentOS, governance: governance, workforce: workforce, level: level };
  }

  function updateIntelligenceStrip() {
    if (!global.document) return;
    const strip = global.document.getElementById('hk-intelligence-strip');
    if (!strip) return;
    const status = runtimeStatus();
    const dot = strip.querySelector('.hk-strip-dot');
    if (dot) dot.className = 'hk-strip-dot' + (status.level === 'offline' ? ' is-off' : status.level === 'warning' ? ' is-warn' : '');
    const modeNode = strip.querySelector('[data-hk-mode]');
    if (modeNode) modeNode.textContent = AppMode.get() === 'field' ? 'Field Mode' : 'Executive Mode';
    const runtimeNode = strip.querySelector('[data-hk-runtime]');
    if (runtimeNode) runtimeNode.textContent = status.online ? ((status.hermes || status.agentOS) ? 'AI ready' : 'Core ready') : 'Offline';
    const gateNode = strip.querySelector('[data-hk-gate]');
    if (gateNode) gateNode.textContent = status.governance ? 'Governed' : 'Guard status unknown';
  }

  function buildStrip() {
    const strip = global.document.createElement('div');
    strip.id = 'hk-intelligence-strip';
    strip.setAttribute('role', 'status');
    strip.innerHTML = '<span class="hk-strip-dot"></span>' +
      '<span class="hk-strip-copy"><b data-hk-mode>Field Mode</b> · <span data-hk-runtime>Core ready</span></span>' +
      '<span class="hk-strip-sep"></span>' +
      '<span class="hk-strip-copy" data-hk-gate>Governed</span>' +
      '<button class="hk-strip-command" type="button">Command</button>';
    strip.querySelector('button').addEventListener('click', openPalette);
    global.document.body.appendChild(strip);

    const orb = global.document.createElement('button');
    orb.id = 'hk-command-orb';
    orb.type = 'button';
    orb.setAttribute('aria-label', 'Open HyperKernel command palette');
    orb.title = 'Command palette (Ctrl+K)';
    orb.textContent = '⌘';
    orb.addEventListener('click', openPalette);
    global.document.body.appendChild(orb);
  }

  function filteredCommands() {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return COMMANDS.slice();
    return COMMANDS.filter(function (command) {
      return (command.title + ' ' + command.detail + ' ' + command.group + ' ' + command.tag).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderPalette() {
    const list = global.document.querySelector('.hk-command-list');
    if (!list) return;
    const rows = filteredCommands();
    if (!rows.length) { list.innerHTML = '<div class="hk-command-empty">No matching command.</div>'; return; }
    let group = '';
    let html = '';
    rows.forEach(function (command, index) {
      if (command.group !== group) { group = command.group; html += '<div class="hk-command-group">' + group + '</div>'; }
      html += '<button class="hk-command-item' + (index === 0 ? ' is-active' : '') + '" type="button" data-command-id="' + command.id + '">' +
        '<span class="hk-command-icon">' + command.icon + '</span>' +
        '<span class="hk-command-copy"><b>' + command.title + '</b><span>' + command.detail + '</span></span>' +
        '<span class="hk-command-tag">' + command.tag + '</span></button>';
    });
    list.innerHTML = html;
    list.querySelectorAll('[data-command-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        const command = COMMANDS.find(function (row) { return row.id === button.getAttribute('data-command-id'); });
        closePalette();
        if (command) command.run();
      });
    });
  }

  function createPalette() {
    const backdrop = global.document.createElement('div');
    backdrop.className = 'hk-command-backdrop hk-shell-hidden';
    backdrop.addEventListener('click', closePalette);
    const palette = global.document.createElement('section');
    palette.className = 'hk-command-palette hk-shell-hidden';
    palette.setAttribute('role', 'dialog');
    palette.setAttribute('aria-modal', 'true');
    palette.setAttribute('aria-label', 'HyperKernel command palette');
    palette.innerHTML = '<div class="hk-command-head"><input class="hk-command-search" type="search" placeholder="Search actions, agents, approvals, jobs…" aria-label="Search commands"><span class="hk-command-key">ESC</span></div><div class="hk-command-list"></div>';
    const input = palette.querySelector('input');
    input.addEventListener('input', function () { commandQuery = input.value || ''; renderPalette(); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        const active = palette.querySelector('.hk-command-item.is-active') || palette.querySelector('.hk-command-item');
        if (active) active.click();
      }
    });
    global.document.body.appendChild(backdrop);
    global.document.body.appendChild(palette);
    renderPalette();
  }

  function openPalette() {
    if (!shellInstalled) return;
    paletteOpen = true;
    commandQuery = '';
    const backdrop = global.document.querySelector('.hk-command-backdrop');
    const palette = global.document.querySelector('.hk-command-palette');
    const input = palette && palette.querySelector('input');
    if (backdrop) backdrop.classList.remove('hk-shell-hidden');
    if (palette) palette.classList.remove('hk-shell-hidden');
    if (input) { input.value = ''; renderPalette(); global.setTimeout(function () { input.focus(); }, 20); }
  }

  function closePalette() {
    paletteOpen = false;
    const backdrop = global.document.querySelector('.hk-command-backdrop');
    const palette = global.document.querySelector('.hk-command-palette');
    if (backdrop) backdrop.classList.add('hk-shell-hidden');
    if (palette) palette.classList.add('hk-shell-hidden');
  }

  function installIntelligentShell() {
    if (!global.document || shellInstalled || global.document.getElementById('hk-command-orb')) return;
    shellInstalled = true;
    buildStrip();
    createPalette();
    updateIntelligenceStrip();
    global.addEventListener('online', updateIntelligenceStrip);
    global.addEventListener('offline', updateIntelligenceStrip);
    global.document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') { event.preventDefault(); paletteOpen ? closePalette() : openPalette(); }
      if (event.key === 'Escape' && paletteOpen) closePalette();
    });
    global.setInterval(updateIntelligenceStrip, 10000);
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', installIntelligentShell, { once: true });
    else installIntelligentShell();
  }
})(typeof window !== 'undefined' ? window : this);
