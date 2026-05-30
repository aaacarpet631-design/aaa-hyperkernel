/*
 * AAA Measurement HUD — the field-facing Bluetooth measurement surface.
 *
 * One bottom-sheet HUD that hosts every screen as a view:
 *   setup → scanner → device details → capture → review → send-to-quote →
 *   history → troubleshooting/manual. Built on the existing AAA_UI kit and the
 *   red theme. Every button does real work or is honestly gated; manual entry
 *   is ALWAYS available so Bluetooth failure never blocks a quote.
 *
 * boot({ jobId, customerId }) opens it for a job. Closing emits the same
 * 'hud:closed' signal the job list listens for, so the detail view refreshes.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function ble() { return global.AAA_BLUETOOTH; }
  function store() { return global.AAA_MEASUREMENT_STORE; }
  function models() { return global.AAA_MEASUREMENT_MODELS; }
  function quote() { return global.AAA_MEASUREMENT_QUOTE; }
  function ai() { return global.AAA_MEASUREMENT_AI; }
  function events() { return global.AAA_EVENTS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const state = { jobId: null, customerId: null, sheet: null, view: 'setup', unsub: null, draft: null };

  function boot(opts) {
    opts = opts || {};
    state.jobId = opts.jobId || null;
    state.customerId = opts.customerId || null;
    state.draft = null;
    const ui = U();
    const sheet = ui.sheet({ title: 'Room Measurement', subtitle: 'AAA Carpet — field capture' });
    state.sheet = sheet;
    document.body.appendChild(sheet.overlay);
    if (ble() && ble().installLifecycleHandlers) ble().installLifecycleHandlers();
    // Re-render on connection state changes so status/battery stay live.
    if (ble()) state.unsub = ble().subscribe(() => { if (state.view === 'scanner' || state.view === 'details' || state.view === 'capture') render(); });
    const origClose = sheet.close;
    sheet.close = function () { if (state.unsub) { state.unsub(); state.unsub = null; } origClose(); if (events()) events().emit('hud:closed', { hud: 'measurement-hud' }); };
    go('setup');
  }

  function go(view) { state.view = view; render(); }

  function render() {
    const body = state.sheet.body;
    body.innerHTML = '';
    switch (state.view) {
      case 'setup': return renderSetup(body);
      case 'scanner': return renderScanner(body);
      case 'details': return renderDetails(body);
      case 'capture': return renderCapture(body);
      case 'review': return renderReview(body);
      case 'quote': return renderSendToQuote(body);
      case 'history': return renderHistory(body);
      case 'manual': return renderTroubleshooting(body);
      default: return renderSetup(body);
    }
  }

  // ---- shared bits ------------------------------------------------------
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function navRow(items) {
    return U().el('div', { className: 'aaa-detail-actions' }, items.map((i) =>
      U().button({ label: i.label, icon: i.icon, variant: i.variant || 'ghost', size: i.size, onClick: i.onClick })));
  }
  function statusPill() {
    const s = ble() ? ble().getState() : { status: 'unsupported' };
    const map = { connected: '#10B981', connecting: '#F59E0B', disconnected: '#A1A1AA', error: '#EF4444', unsupported: '#EF4444' };
    return U().statusBadge((s.deviceName ? s.deviceName + ' · ' : '') + s.status + (s.battery != null ? ' · 🔋' + s.battery + '%' : ''), map[s.status] || '#A1A1AA');
  }

  // ---- 1. Setup ---------------------------------------------------------
  function renderSetup(body) {
    const ui = U();
    body.appendChild(title('Bluetooth Measurement Setup'));
    const supported = ble() && ble().isSupported();
    const reason = ble() ? ble().unsupportedReason() : 'Bluetooth controller not loaded.';

    body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + (supported ? '🟢 Bluetooth supported' : '🟠 Bluetooth not available here') + '</strong>' +
      '<div class="aaa-list-sub">' + esc(supported ? 'You can scan for and connect a laser measure.' : reason) + '</div>' }));

    if (supported) {
      body.appendChild(ui.button({ label: 'Scan for a device', icon: '🔍', variant: 'primary', full: true, onClick: () => go('scanner') }));
    }
    // Manual entry is ALWAYS offered — the fallback that never blocks a quote.
    body.appendChild(ui.button({ label: 'Enter measurements manually', icon: '✍️', variant: supported ? 'secondary' : 'primary', full: true, onClick: () => { startManualCapture(); } }));
    body.appendChild(ui.button({ label: 'Measurement history', icon: '📋', variant: 'ghost', full: true, onClick: () => go('history') }));
    body.appendChild(ui.button({ label: 'Troubleshooting / Manual mode', icon: '🛟', variant: 'ghost', full: true, onClick: () => go('manual') }));
    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Tip: measurements save on this device first, then sync to the cloud automatically when you have signal.' }));
  }

  // ---- 2. Device Scanner ------------------------------------------------
  async function renderScanner(body) {
    const ui = U();
    body.appendChild(title('Device Scanner'));
    body.appendChild(statusPill());

    if (!(ble() && ble().isSupported())) {
      body.appendChild(ui.el('p', { className: 'aaa-empty', text: ble() ? ble().unsupportedReason() : 'Bluetooth unavailable.' }));
      body.appendChild(ui.button({ label: 'Use manual entry instead', icon: '✍️', variant: 'primary', full: true, onClick: startManualCapture }));
      body.appendChild(navRow([{ label: 'Back', onClick: () => go('setup') }]));
      return;
    }

    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Tap “Scan” to open your phone’s Bluetooth picker, choose your laser, then connect.' }));
    body.appendChild(ui.button({ label: 'Scan (open picker)', icon: '🔍', variant: 'primary', full: true, onClick: async () => {
      const res = await ble().scanAndPick();
      if (!res.ok) { toast(body, res.message || res.error, '#EF4444'); return; }
      go('details');
    } }));

    // Previously paired devices.
    const devices = store() ? await store().listDevices() : [];
    if (devices.length) {
      body.appendChild(title('Paired devices'));
      devices.forEach((d) => {
        const row = ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(d.nickname || d.name) + '</strong>' +
          '<div class="aaa-list-sub">' + esc(d.manufacturer || d.deviceType) + (d.lastConnectedAt ? ' · last ' + esc(fmt(d.lastConnectedAt)) : '') + '</div>' });
        body.appendChild(row);
      });
      body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Browsers can’t silently reconnect — tap Scan and re-pick the same device.' }));
    }
    body.appendChild(navRow([{ label: 'Back', onClick: () => go('setup') }]));
  }

  // ---- 3. Connected Device Details -------------------------------------
  async function renderDetails(body) {
    const ui = U();
    const s = ble().getState();
    body.appendChild(title('Device Details'));
    body.appendChild(statusPill());

    const rec = s.deviceId && store() ? await store().getDevice(s.deviceId) : null;
    const nickInput = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Nickname (e.g. “Blue laser”)' } });
    if (rec && rec.nickname) nickInput.value = rec.nickname;
    body.appendChild(ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: 'Device nickname' }), nickInput]));
    body.appendChild(ui.button({ label: 'Save nickname', variant: 'secondary', full: true, onClick: async () => {
      if (s.deviceId) { await ble().setNickname(s.deviceId, nickInput.value.trim()); toast(body, 'Saved.', '#10B981'); }
    } }));

    if (s.status === 'connected') {
      body.appendChild(ui.button({ label: 'Refresh battery', icon: '🔋', variant: 'ghost', full: true, onClick: async () => { await ble().refreshBattery(); render(); } }));
      body.appendChild(ui.button({ label: 'Start measuring', icon: '📐', variant: 'primary', full: true, onClick: () => startBluetoothCapture() }));
      body.appendChild(ui.button({ label: 'Disconnect', icon: '⏏', variant: 'danger', full: true, onClick: async () => { await ble().disconnect(); render(); } }));
    } else {
      body.appendChild(ui.button({ label: s.status === 'connecting' ? 'Connecting…' : 'Connect', icon: '🔗', variant: 'primary', full: true, disabled: s.status === 'connecting', onClick: async () => {
        const res = await ble().connect();
        if (!res.ok) toast(body, res.message || res.error, '#EF4444');
        render();
      } }));
      body.appendChild(ui.button({ label: 'Reconnect last device', icon: '↻', variant: 'secondary', full: true, onClick: async () => {
        const res = await ble().reconnect();
        if (!res.ok) toast(body, res.message || res.error, '#F59E0B');
        render();
      } }));
    }
    body.appendChild(ui.button({ label: 'Manual entry instead', icon: '✍️', variant: 'ghost', full: true, onClick: startManualCapture }));
    body.appendChild(navRow([{ label: 'Scanner', onClick: () => go('scanner') }, { label: 'Close', onClick: () => state.sheet.close() }]));
  }

  // ---- 4. Measurement Capture ------------------------------------------
  // Shared capture screen for both Bluetooth and manual. The draft holds the
  // in-progress room; BLE readings drop into whichever field is "armed".
  function startBluetoothCapture() { state.draft = blankDraft('bluetooth'); state.armField = 'length'; go('capture'); }
  function startManualCapture() { state.draft = blankDraft('manual'); state.armField = null; go('capture'); }
  function blankDraft(source) {
    return { roomName: '', length: '', width: '', squareFeet: '', linearFeet: '', stairsCount: '', notes: '', source: source, manualOverride: false };
  }

  function renderCapture(body) {
    const ui = U();
    const d = state.draft || (state.draft = blankDraft('manual'));
    const bt = d.source === 'bluetooth';
    body.appendChild(title(bt ? 'Capture (Bluetooth)' : 'Capture (Manual)'));
    if (bt) body.appendChild(statusPill());

    // Live BLE reading banner + "use it" into the armed field.
    if (bt && ble()) {
      const r = ble().takeReading();
      const banner = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>Last reading: ' + (r ? r.feet + ' ft' : '—') + '</strong>' +
        '<div class="aaa-list-sub">' + (r ? 'unit ' + esc(r.unit) + ' · confidence ' + Math.round((r.confidence || 0) * 100) + '%' : 'Pull the trigger on your laser to send a reading.') + '</div>' });
      body.appendChild(banner);
    }

    const fields = [
      ['roomName', 'Room name', 'text', 'e.g. Living room'],
      ['length', 'Length (ft)', 'number', '0'],
      ['width', 'Width (ft)', 'number', '0'],
      ['squareFeet', 'Square feet (auto)', 'number', 'auto from L×W'],
      ['linearFeet', 'Linear feet', 'number', 'for stretch/repair'],
      ['stairsCount', 'Stairs', 'number', '0']
    ];
    const inputs = {};
    fields.forEach(([key, label, type, ph]) => {
      const input = ui.el('input', { className: 'aaa-input', attrs: { type: type, placeholder: ph, inputmode: type === 'number' ? 'decimal' : 'text' } });
      input.value = d[key];
      input.addEventListener('input', () => {
        d[key] = input.value;
        if (key === 'squareFeet') d.manualOverride = true;
        if ((key === 'length' || key === 'width') && !d.manualOverride) {
          const l = parseFloat(d.length), w = parseFloat(d.width);
          if (isFinite(l) && isFinite(w)) { d.squareFeet = String(Math.round(l * w * 100) / 100); inputs.squareFeet.value = d.squareFeet; }
        }
      });
      inputs[key] = input;
      const wrap = ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: label }), input]);
      // In BLE mode, each numeric field gets an "arm" button so a trigger-pull fills it.
      if (bt && type === 'number' && key !== 'squareFeet') {
        wrap.appendChild(ui.button({ label: 'Use laser → ' + label, size: 'sm', variant: state.armField === key ? 'success' : 'ghost', onClick: () => {
          const reading = ble().takeReading();
          if (!reading) { toast(body, 'No reading yet — pull the laser trigger first.', '#F59E0B'); return; }
          d[key] = String(reading.feet);
          input.value = d[key];
          if ((key === 'length' || key === 'width') && !d.manualOverride) {
            const l = parseFloat(d.length), w = parseFloat(d.width);
            if (isFinite(l) && isFinite(w)) { d.squareFeet = String(Math.round(l * w * 100) / 100); inputs.squareFeet.value = d.squareFeet; }
          }
          toast(body, label + ' set to ' + reading.feet + ' ft', '#10B981');
        } }));
      }
      body.appendChild(wrap);
    });

    const notes = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: 'Notes (transitions, furniture, pet damage…)' } });
    notes.value = d.notes; notes.addEventListener('input', () => { d.notes = notes.value; });
    body.appendChild(ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: 'Notes' }), notes]));

    body.appendChild(ui.button({ label: 'Save room', icon: '💾', variant: 'primary', full: true, onClick: () => saveDraft(body) }));
    body.appendChild(navRow([
      bt ? { label: 'Device', onClick: () => go('details') } : { label: 'Setup', onClick: () => go('setup') },
      { label: 'Review all rooms', onClick: () => go('review') }
    ]));
  }

  async function saveDraft(body) {
    const d = state.draft;
    const session = models().newSession({
      jobId: state.jobId, customerId: state.customerId,
      deviceId: d.source === 'bluetooth' && ble() ? ble().getState().deviceId : null,
      roomName: d.roomName, length: d.length, width: d.width, squareFeet: d.squareFeet,
      linearFeet: d.linearFeet, stairsCount: d.stairsCount, notes: d.notes,
      source: d.source, manualOverride: d.manualOverride,
      confidenceScore: d.source === 'bluetooth' ? 0.9 : null
    });
    const existing = await store().listSessions({ jobId: state.jobId });
    const v = models().validateSession(session, { existing: existing });
    if (!v.ok) { toast(body, v.errors.join(' '), '#EF4444'); return; }
    const res = await store().saveSession(session);
    if (!res.ok) { toast(body, 'Could not save: ' + (res.error || ''), '#EF4444'); return; }
    if (v.warnings.length) toast(body, '⚠ ' + v.warnings.join(' '), '#F59E0B');
    else toast(body, 'Saved “' + session.roomName + '”.', '#10B981');
    state.draft = blankDraft(d.source); // ready for next room
    go('review');
  }

  // ---- 5. Room Measurement Review --------------------------------------
  async function renderReview(body) {
    const ui = U();
    body.appendChild(title('Review Rooms'));
    const sessions = await store().listSessions({ jobId: state.jobId });
    if (!sessions.length) { body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No rooms captured yet.' })); }
    let totalSq = 0;
    sessions.forEach((s) => {
      totalSq += s.squareFeet || 0;
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(s.roomName) + ' · ' + (s.squareFeet != null ? s.squareFeet + ' ft²' : '—') + '</strong>' +
        '<div class="aaa-list-sub">' + [s.length && s.width ? s.length + '×' + s.width + ' ft' : null, s.linearFeet ? s.linearFeet + ' lin ft' : null, s.stairsCount ? s.stairsCount + ' stairs' : null, s.source].filter(Boolean).join(' · ') + '</div>' +
        (s.notes ? '<div class="aaa-list-sub">📝 ' + esc(s.notes) + '</div>' : '') });
      row.appendChild(ui.button({ label: 'Delete', size: 'sm', variant: 'ghost', onClick: async () => { await store().deleteSession(s.id); render(); } }));
      body.appendChild(row);
    });
    if (sessions.length) body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Total: ' + Math.round(totalSq * 10) / 10 + ' ft² across ' + sessions.length + ' room(s)</strong>' }));

    body.appendChild(ui.button({ label: 'Add another room', icon: '➕', variant: 'secondary', full: true, onClick: () => go('capture') }));
    if (ai()) body.appendChild(ui.button({ label: 'AI review measurements', icon: '🧠', variant: 'secondary', full: true, onClick: () => runAIReview(body, sessions) }));
    if (sessions.length) body.appendChild(ui.button({ label: 'Send to quote', icon: '🧾', variant: 'primary', full: true, onClick: () => go('quote') }));
    body.appendChild(navRow([{ label: 'Setup', onClick: () => go('setup') }, { label: 'Close', onClick: () => state.sheet.close() }]));
  }

  async function runAIReview(body, sessions) {
    const ui = U();
    const card = ui.el('div', {}); card.appendChild(ui.spinner('Reviewing measurements…'));
    body.appendChild(card);
    const res = await ai().review(sessions, { jobId: state.jobId });
    card.innerHTML = '';
    const r = res.review || {};
    card.appendChild(title('AI Review (' + (res.mode || 'local') + ')'));
    if (res.note) card.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: res.note }));
    const flag = (label, val) => { if (val && (typeof val !== 'object' || val.length)) card.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + label + '</strong><div class="aaa-list-sub">' + esc(Array.isArray(val) ? val.join(' · ') : val) + '</div>' })); };
    card.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Quote confidence: ' + (r.quoteConfidence != null ? r.quoteConfidence + '%' : '—') + '</strong>' }));
    flag('Missing rooms', r.missingRooms);
    flag('Unrealistic readings', r.unrealistic);
    flag('Stair pricing risk', r.stairRisk);
    flag('Install waste', r.wasteWarning);
    flag('Repair vs replacement', r.repairVsReplace);
    flag('Field notes', r.fieldNotesSummary);
    card.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'AI is advisory only — you confirm the final price.' }));
  }

  // ---- 6. Send to Quote -------------------------------------------------
  async function renderSendToQuote(body) {
    const ui = U();
    body.appendChild(title('Send to Quote'));
    const sessions = await store().listSessions({ jobId: state.jobId });
    if (!sessions.length) { body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No rooms to quote.' })); body.appendChild(navRow([{ label: 'Back', onClick: () => go('review') }])); return; }

    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Pick the services to price from these measurements.' }));
    const chosen = {};
    quote().serviceOptions().forEach((opt) => {
      const cb = ui.el('input', { attrs: { type: 'checkbox' } });
      cb.addEventListener('change', () => { chosen[opt.id] = cb.checked; });
      const row = ui.el('label', { className: 'aaa-list-row', style: { display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' } }, [cb, ui.el('span', { html: '<strong>' + esc(opt.label) + '</strong>' })]);
      body.appendChild(row);
    });

    const out = ui.el('div', {});
    body.appendChild(ui.button({ label: 'Build draft quote', icon: '🧮', variant: 'primary', full: true, onClick: () => {
      const selections = Object.keys(chosen).filter((k) => chosen[k]).map((id) => ({ serviceId: id, sessions: sessions }));
      if (!selections.length) { toast(body, 'Pick at least one service.', '#F59E0B'); return; }
      const q = quote().buildQuote(selections);
      state._lastQuote = q; state._lastSessions = sessions;
      out.innerHTML = '';
      out.appendChild(title('Draft (internal) — needs your review'));
      q.lines.forEach((l) => out.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(l.label) + ' · ' + l.range + '</strong>' +
        '<div class="aaa-list-sub">' + esc(l.basis) + ' · labor $' + l._labor + ' · material $' + l._material + '</div>' })));
      out.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Total ' + q.totalRange + '</strong><div class="aaa-list-sub">internal labor $' + q._laborTotal + ' · material $' + q._materialTotal + '</div>' }));
      out.appendChild(ui.button({ label: 'Preview customer receipt', icon: '🧾', variant: 'secondary', full: true, onClick: () => showReceipt(q) }));
      out.appendChild(ui.button({ label: 'Apply to job (for review)', icon: '✅', variant: 'primary', full: true, onClick: () => applyToJob(body, q, sessions) }));
    } }));
    body.appendChild(out);
    body.appendChild(navRow([{ label: 'Back', onClick: () => go('review') }]));
  }

  function showReceipt(q) {
    const ui = U();
    const r = quote().toReceipt(q, {});
    const s = ui.sheet({ title: r.businessName, subtitle: 'Estimate', size: 'sm' });
    document.body.appendChild(s.overlay);
    r.items.forEach((it) => s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(it.description) + '</strong><div class="aaa-list-sub">$' + it.amount + '</div>' })));
    s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Estimated total: ' + esc(r.estimateRange) + '</strong>' }));
    s.body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: r.note }));
  }

  async function applyToJob(body, q, sessions) {
    if (!state.jobId) { toast(body, 'Open this from a job to apply estimates.', '#F59E0B'); return; }
    const entries = quote().toEstimateEntries(q, { sessionIds: sessions.map((s) => s.id) });
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    let job = await storage.get('jobs', state.jobId);
    if (!job) { toast(body, 'Job not found.', '#EF4444'); return; }
    const updated = Object.assign({}, job, { estimates: (Array.isArray(job.estimates) ? job.estimates : []).concat(entries) });
    await storage.put('jobs', state.jobId, updated);
    // Mirror via the unified data layer so it syncs like every other estimate.
    try { if (global.AAA_DATA && global.AAA_DATA.put) await global.AAA_DATA.put('jobs', state.jobId, updated); } catch (_) {}
    if (events()) events().emit('estimate.added', { jobId: state.jobId, count: entries.length, source: 'measurement' });
    toast(body, entries.length + ' estimate(s) added to the job for your review.', '#10B981');
  }

  // ---- 7. Measurement History ------------------------------------------
  async function renderHistory(body) {
    const ui = U();
    body.appendChild(title('Measurement History'));
    const sessions = await store().listSessions(state.jobId ? { jobId: state.jobId } : {});
    if (!sessions.length) { body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No measurements yet.' })); }
    sessions.slice(0, 50).forEach((s) => body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(s.roomName) + ' · ' + (s.squareFeet != null ? s.squareFeet + ' ft²' : '—') + '</strong>' +
      '<div class="aaa-list-sub">' + esc(s.source) + ' · ' + esc(fmt(s.updatedAt)) + (s.syncedToCloud ? ' · ☁ synced' : ' · 💾 local') + '</div>' })));
    if (store() && store().cloudReady()) body.appendChild(ui.button({ label: 'Sync now', icon: '☁', variant: 'secondary', full: true, onClick: async () => { const r = await store().syncPending(); toast(body, r.ok ? 'Synced.' : ('Synced ' + (r.pushed || 0) + ', ' + (r.failed || 0) + ' pending'), r.ok ? '#10B981' : '#F59E0B'); } }));
    body.appendChild(navRow([{ label: 'Back', onClick: () => go('setup') }]));
  }

  // ---- 8. Troubleshooting / Manual Mode --------------------------------
  function renderTroubleshooting(body) {
    const ui = U();
    body.appendChild(title('Troubleshooting / Manual Mode'));
    const supported = ble() && ble().isSupported();
    const checks = [
      ['Web Bluetooth', supported ? 'available' : 'not available', supported],
      ['Secure (https)', global.isSecureContext ? 'yes' : 'no', !!global.isSecureContext],
      ['Storage', store() ? 'ready' : 'missing', !!store()],
      ['Cloud sync', store() && store().cloudReady() ? 'connected' : 'local-only', store() && store().cloudReady()]
    ];
    checks.forEach(([k, v, ok]) => body.appendChild(ui.el('div', { className: 'vision-row' }, [
      ui.el('span', { className: 'vision-row__k', text: k }),
      ui.el('span', { className: 'vision-row__v', text: v, style: { color: ok ? '#10B981' : '#F59E0B' } })
    ])));
    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: supported
      ? 'If a device won’t connect: make sure it’s on and in range, turn its Bluetooth on, then Scan and re-pick it. Move closer if it times out.'
      : (ble() ? ble().unsupportedReason() : '') }));
    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Manual entry always works and never blocks a quote — use it any time Bluetooth gives you trouble.' }));
    body.appendChild(ui.button({ label: 'Enter measurements manually', icon: '✍️', variant: 'primary', full: true, onClick: startManualCapture }));
    body.appendChild(navRow([{ label: 'Back', onClick: () => go('setup') }]));
  }

  // ---- helpers ----------------------------------------------------------
  function toast(body, msg, color) {
    const t = U().el('div', { className: 'aaa-list-row', style: { borderColor: color || '#2A2A33' }, html: '<strong style="color:' + (color || '#F8FAFC') + '">' + esc(msg) + '</strong>' });
    body.insertBefore(t, body.firstChild);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
  }
  function fmt(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  global.AAA_MEASUREMENT_HUD_UI = { boot: boot };
})(typeof window !== 'undefined' ? window : this);
