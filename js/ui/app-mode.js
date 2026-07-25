/*
 * AAA App Mode — Field and Executive operating modes.
 * Adds a context-aware command shell without changing business data or bypassing
 * governance. Every action only activates an existing UI control or prepares chat.
 */
;(function (global) {
  'use strict';

  function installStylesheet(id, href) {
    if (!global.document || global.document.getElementById(id)) return;
    const link = global.document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    global.document.head.appendChild(link);
  }
  installStylesheet('aaa-ui-polish-css', '/css/ui-polish.css');
  installStylesheet('aaa-ui-efficiency-css', '/css/ui-efficiency.css');

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
      if (paletteOpen) renderPalette();
      return { ok: true, mode: mode };
    },

    toggle() { return this.set(this.get() === 'field' ? 'executive' : 'field'); },

    navItems(mode) { return (NAV[mode || this.get()] || NAV.field).map(function (x) { return Object.assign({}, x); }); },

    landingTab(mode) { return LANDING[mode || this.get()] || 'measure'; },

    hasTab(tab, mode) { return this.navItems(mode).some(function (n) { return n.tab === tab; }); }
  };

  global.AAA_APP_MODE = AppMode;

  const COMMANDS = [
    { group: 'Navigate', id: 'command', icon: '🛰', title: 'Open Command', detail: 'Priorities, risks, and decisions', tag: 'Executive', shortcut: 'Alt 1', run: function () { ensureMode('executive'); activateTab('focus'); } },
    { group: 'Navigate', id: 'measure', icon: '📐', title: 'Start Measurement', detail: 'Begin the field capture workflow', tag: 'Field', shortcut: 'Alt 1', run: function () { ensureMode('field'); activateTab('measure'); } },
    { group: 'Navigate', id: 'jobs', icon: '🗂', title: 'Open Jobs', detail: 'Active work and attention items', tag: 'Work', shortcut: 'Alt 2', run: function () { activateTab('jobs'); } },
    { group: 'Navigate', id: 'chat', icon: '💬', title: 'Ask HyperKernel', detail: 'Open the business copilot', tag: 'AI', shortcut: 'Alt 3', run: function () { openChat(''); } },
    { group: 'Navigate', id: 'business', icon: '📊', title: 'Open Business', detail: 'Revenue and operating intelligence', tag: 'Executive', run: function () { ensureMode('executive'); activateTab('business'); } },
    { group: 'Intelligence', id: 'briefing', icon: '☀', title: 'Owner briefing', detail: 'What needs attention, ranked by impact', tag: 'Brief', run: function () { openChat('What needs my attention right now? Prioritize by business impact and cite the evidence for each item.'); } },
    { group: 'Intelligence', id: 'mission', icon: '◈', title: 'Start governed mission', detail: 'Objective, evidence, review, and rollback', tag: 'Governed', run: function () { openChat('Create a governed mission for this objective: '); } },
    { group: 'Intelligence', id: 'agents', icon: '🤖', title: 'Agent Workforce', detail: 'Health, work, and approvals', tag: 'Agents', run: function () { clickByText(['Agent Workforce', 'AI Team']); } },
    { group: 'Governance', id: 'approvals', icon: '✓', title: 'Open Approvals', detail: 'Decisions waiting for human authority', tag: 'Human', run: function () { clickByText(['Approvals', 'Approval']); } },
    { group: 'Governance', id: 'mode', icon: '↔', title: 'Switch operating mode', detail: 'Field or Executive workflow', tag: 'Mode', run: function () { AppMode.toggle(); activateTab(AppMode.landingTab()); } }
  ];

  const MODE_ORDER = {
    field: ['measure', 'jobs', 'chat', 'mission', 'approvals', 'agents', 'mode', 'briefing', 'command', 'business'],
    executive: ['briefing', 'command', 'approvals', 'jobs', 'business', 'chat', 'mission', 'agents', 'mode', 'measure']
  };

  let shellInstalled = false;
  let paletteOpen = false;
  let commandQuery = '';
  let activeIndex = 0;

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
      return wanted.some(function (label) { return t.indexOf(label) !== -1; });
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
    let level = online ? 'ready' : 'offline';
    if (online && !(hermes || agentOS)) level = 'warning';
    return { online: online, hermes: hermes, agentOS: agentOS, governance: governance, level: level };
  }

  function primaryCommandId() { return AppMode.get() === 'field' ? 'measure' : 'briefing'; }

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
    const primary = strip.querySelector('[data-hk-primary]');
    if (primary) {
      primary.textContent = AppMode.get() === 'field' ? 'Start measurement' : 'Owner briefing';
      primary.setAttribute('data-command-id', primaryCommandId());
    }
  }

  function runCommand(id) {
    const command = COMMANDS.find(function (row) { return row.id === id; });
    closePalette();
    if (command) command.run();
  }

  function buildStrip() {
    const strip = global.document.createElement('div');
    strip.id = 'hk-intelligence-strip';
    strip.setAttribute('role', 'status');
    strip.innerHTML = '<span class="hk-strip-dot"></span>' +
      '<span class="hk-strip-copy"><b data-hk-mode>Field Mode</b> · <span data-hk-runtime>Core ready</span></span>' +
      '<span class="hk-strip-sep"></span>' +
      '<span class="hk-strip-copy" data-hk-gate>Governed</span>' +
      '<button class="hk-strip-primary" type="button" data-hk-primary data-command-id="measure">Start measurement</button>' +
      '<button class="hk-strip-command" type="button" aria-label="Open command palette" title="Command palette (Ctrl+K)">⌘</button>';
    strip.querySelector('[data-hk-primary]').addEventListener('click', function (event) { runCommand(event.currentTarget.getAttribute('data-command-id')); });
    strip.querySelector('.hk-strip-command').addEventListener('click', openPalette);
    global.document.body.appendChild(strip);
  }

  function orderedCommands() {
    const order = MODE_ORDER[AppMode.get()] || MODE_ORDER.field;
    return COMMANDS.slice().sort(function (a, b) { return order.indexOf(a.id) - order.indexOf(b.id); });
  }

  function filteredCommands() {
    const rows = orderedCommands();
    const q = commandQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(function (command) {
      return (command.title + ' ' + command.detail + ' ' + command.group + ' ' + command.tag).toLowerCase().indexOf(q) !== -1;
    });
  }

  function setActive(index) {
    const items = Array.from(global.document.querySelectorAll('.hk-command-item'));
    if (!items.length) return;
    activeIndex = Math.max(0, Math.min(index, items.length - 1));
    items.forEach(function (item, row) { item.classList.toggle('is-active', row === activeIndex); });
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function renderPalette() {
    const list = global.document.querySelector('.hk-command-list');
    if (!list) return;
    const rows = filteredCommands();
    activeIndex = 0;
    if (!rows.length) { list.innerHTML = '<div class="hk-command-empty">No matching command.</div>'; return; }
    let html = '';
    rows.forEach(function (command, index) {
      html += '<button class="hk-command-item' + (index === 0 ? ' is-active' : '') + '" type="button" data-command-id="' + command.id + '">' +
        '<span class="hk-command-icon">' + command.icon + '</span>' +
        '<span class="hk-command-copy"><b>' + command.title + '</b><span>' + command.detail + '</span></span>' +
        (command.shortcut ? '<span class="hk-command-keyhint">' + command.shortcut + '</span>' : '<span class="hk-command-tag">' + command.tag + '</span>') + '</button>';
    });
    list.innerHTML = html;
    list.querySelectorAll('[data-command-id]').forEach(function (button) {
      button.addEventListener('click', function () { runCommand(button.getAttribute('data-command-id')); });
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
    palette.innerHTML = '<div class="hk-command-head"><input class="hk-command-search" type="search" placeholder="Type an action…" aria-label="Search commands"><span class="hk-command-key">ESC</span></div><div class="hk-command-list"></div>';
    const input = palette.querySelector('input');
    input.addEventListener('input', function () { commandQuery = input.value || ''; renderPalette(); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1); }
      if (event.key === 'Enter') {
        event.preventDefault();
        const items = palette.querySelectorAll('.hk-command-item');
        if (items[activeIndex]) items[activeIndex].click();
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
    if (!global.document || shellInstalled || global.document.getElementById('hk-intelligence-strip')) return;
    shellInstalled = true;
    buildStrip();
    createPalette();
    updateIntelligenceStrip();
    global.addEventListener('online', updateIntelligenceStrip);
    global.addEventListener('offline', updateIntelligenceStrip);
    global.document.addEventListener('keydown', function (event) {
      const key = String(event.key).toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'k') { event.preventDefault(); paletteOpen ? closePalette() : openPalette(); }
      if (event.altKey && key === '1') { event.preventDefault(); runCommand(AppMode.get() === 'field' ? 'measure' : 'command'); }
      if (event.altKey && key === '2') { event.preventDefault(); runCommand('jobs'); }
      if (event.altKey && key === '3') { event.preventDefault(); runCommand('chat'); }
      if (event.key === 'Escape' && paletteOpen) closePalette();
    });
    global.setInterval(updateIntelligenceStrip, 10000);
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', installIntelligentShell, { once: true });
    else installIntelligentShell();
  }
})(typeof window !== 'undefined' ? window : this);
