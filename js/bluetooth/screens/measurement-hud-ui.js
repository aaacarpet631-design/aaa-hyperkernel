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
  function seqEngine() { return global.AAA_CAPTURE_SEQUENCER; }
  function events() { return global.AAA_EVENTS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const state = { jobId: null, customerId: null, sheet: null, view: 'setup', unsub: null, draft: null, seq: null };

  // Tear down any running auto-measure sequence (on save, nav away, or close).
  function stopSeq() { if (state.seq) { try { state.seq.stop(); } catch (_) {} state.seq = null; } }

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
    sheet.close = function () { stopSeq(); if (state.unsub) { state.unsub(); state.unsub = null; } origClose(); if (events()) events().emit('hud:closed', { hud: 'measurement-hud' }); };
    go('setup');

    // Auto-reconnect: if the tech already paired their laser once, silently
    // re-acquire it (no Scan, no picker) and watch for it powering on while
    // this screen is open. Fire-and-forget — the subscribe above re-renders
    // status as it transitions. Manual Scan stays fully available either way.
    if (ble() && ble().isSupported && ble().isSupported()) {
      try { if (ble().autoReconnect) Promise.resolve(ble().autoReconnect()).catch(() => {}); } catch (_) {}
      try { if (ble().watchForDevice) Promise.resolve(ble().watchForDevice()).catch(() => {}); } catch (_) {}
      // With a remembered device, land on the scanner so the tech sees a live
      // "Looking for your Huepar…" status immediately instead of the setup menu.
      if (ble().lastKnownDeviceId) {
        Promise.resolve(ble().lastKnownDeviceId()).then((id) => {
          if (id && state.sheet === sheet && state.view === 'setup') go('scanner');
        }).catch(() => {});
      }
    }
  }

  function go(view) { if (state.view === 'capture' && view !== 'capture') stopSeq(); state.view = view; render(); }

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

    // Honest live auto-reconnect status. While the controller hunts for the
    // remembered laser the tech sees it happening; manual Scan stays right below.
    const s = ble().getState();
    if (s.status === 'connecting') {
      body.appendChild(ui.el('div', { className: 'aaa-list-row', style: { borderColor: '#F59E0B' }, html:
        '<strong>🔄 Looking for your ' + esc(s.deviceName || 'Huepar') + '…</strong>' +
        '<div class="aaa-list-sub">Make sure the laser is powered on. If it doesn’t connect, tap Scan below to pick it manually.</div>' }));
    } else if (s.status === 'connected') {
      body.appendChild(ui.button({ label: 'Connected — view device', icon: '✅', variant: 'primary', full: true, onClick: () => go('details') }));
    }

    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Tap “Scan” to open your phone’s Bluetooth picker, choose your laser, then connect.' }));
    body.appendChild(ui.button({ label: 'Scan (open picker)', icon: '🔍', variant: 'primary', full: true, onClick: async () => {
      const res = await ble().scanAndPick();
      if (!res.ok) { toast(body, res.message || res.error, '#EF4444'); return; }
      go('details');
    } }));
    body.appendChild(ui.button({ label: 'Measure manually', icon: '📏', variant: 'secondary', full: true, onClick: startManualCapture }));
    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'No laser? Keep moving. Manual rooms save to the same review screen and quote flow.' }));

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
      body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Your last laser reconnects automatically while this screen is open (Chrome on Android). If it doesn’t, tap Scan and re-pick it.' }));
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
      // Self-diagnosing panel: when the last connect failed, show the REAL cause
      // and the device's advertised services instead of a bare "error" pill.
      if (s.status === 'error' && s.errorDetail) {
        const d = s.errorDetail;
        const svcs = (d.discoveredServices && d.discoveredServices.length) ? d.discoveredServices.join(', ') : 'none discovered';
        body.appendChild(ui.el('div', { className: 'aaa-list-row', style: { borderColor: '#EF4444' }, html:
          '<strong style="color:#EF4444">Connection failed</strong>' +
          '<div class="aaa-list-sub">' + esc(d.message || s.error || 'Unknown error') + '</div>' +
          (d.errorName ? '<div class="aaa-list-sub">Type: ' + esc(d.errorName) + '</div>' : '') +
          (d.deviceName ? '<div class="aaa-list-sub">Device: ' + esc(d.deviceName) + '</div>' : '') +
          '<div class="aaa-list-sub">Services seen: ' + esc(svcs) + '</div>' }));
      }
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
    return { roomName: '', length: '', width: '', squareFeet: '', linearFeet: '', linearYards: '', stairsCount: '', notes: '', source: source, manualOverride: false };
  }

  // AAA carpet ships on a 12-ft broadloom roll; reuse the layout engine's roll
  // width when it's loaded so there's a single source of truth.
  function rollWidthFt() { const E = global.AAA_LAYOUT_CONSTRAINT_ENGINE; return (E && E.ROLL_WIDTH_FT) || 12; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // Recompute the derived fields from whatever the tech has entered.
  //   square feet : L×W is authoritative; otherwise fall back to a linear run
  //                 off the 12-ft roll (linear ft × roll width). A manual
  //                 square-feet override always wins.
  //   linear yards: always linear ft ÷ 3 (3 ft to the yard).
  function recalc(d, inputs) {
    const l = parseFloat(d.length), w = parseFloat(d.width), lf = parseFloat(d.linearFeet);
    if (!d.manualOverride) {
      let sq = null;
      if (isFinite(l) && isFinite(w)) sq = l * w;
      else if (isFinite(lf)) sq = lf * rollWidthFt();
      d.squareFeet = sq == null ? '' : String(round2(sq));
      if (inputs.squareFeet) inputs.squareFeet.value = d.squareFeet;
    }
    d.linearYards = isFinite(lf) ? String(round2(lf / 3)) : '';
    if (inputs.linearYards) inputs.linearYards.value = d.linearYards;
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

      // If the device supports a remote shutter (e.g. Huepar BLE), let the tech
      // fire it from the app; otherwise they use the button on the laser.
      if (ble().canMeasure && ble().canMeasure()) {
        body.appendChild(ui.button({ label: 'Trigger laser measurement', icon: '📡', variant: 'secondary', full: true, onClick: async () => {
          const res = await ble().measure();
          if (!res || !res.ok) toast(body, (res && res.message) || 'Could not trigger the laser.', '#F59E0B');
          else toast(body, 'Measuring… the reading will appear above.', '#10B981');
        } }));
      }

      // Guided auto-measure: walk length → width, auto-advancing on confident
      // readings. Available whenever the sequencer is loaded; works with a
      // remote shutter (auto-fires) or a manual laser (tech pulls the trigger).
      if (seqEngine() && !state.seq) {
        body.appendChild(ui.button({ label: 'Auto-measure room', icon: '▶️', variant: 'primary', full: true, onClick: () => startAutoMeasure(d) }));
      }
      if (state.seq) body.appendChild(autoPanel(body));
    }

    const fields = [
      ['roomName', 'Room name', 'text', 'e.g. Living room'],
      ['length', 'Length (ft)', 'number', '0'],
      ['width', 'Width (ft)', 'number', '0'],
      ['squareFeet', 'Square feet (auto)', 'number', 'auto from L×W or linear ft'],
      ['linearFeet', 'Linear feet', 'number', 'for stretch / repair / roll order'],
      ['linearYards', 'Linear yards (auto)', 'number', 'auto from linear ft'],
      ['stairsCount', 'Stairs', 'number', '0']
    ];
    const derived = { linearYards: true }; // read-only, computed for the tech
    const inputs = {};
    fields.forEach(([key, label, type, ph]) => {
      const attrs = { type: type, placeholder: ph, inputmode: type === 'number' ? 'decimal' : 'text' };
      if (derived[key]) attrs.readonly = 'readonly';
      const input = ui.el('input', { className: 'aaa-input' + (derived[key] ? ' aaa-input--readonly' : ''), attrs: attrs });
      input.value = d[key];
      input.addEventListener('input', () => {
        d[key] = input.value;
        if (key === 'squareFeet') d.manualOverride = true;
        if (key === 'length' || key === 'width' || key === 'linearFeet') recalc(d, inputs);
      });
      inputs[key] = input;
      const wrap = ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: label }), input]);
      // In BLE mode, each typed numeric field gets an "arm" button so a
      // trigger-pull fills it. Auto/derived fields never get one.
      if (bt && type === 'number' && key !== 'squareFeet' && !derived[key]) {
        wrap.appendChild(ui.button({ label: 'Use laser → ' + label, size: 'sm', variant: state.armField === key ? 'success' : 'ghost', onClick: () => {
          const reading = ble().takeReading();
          if (!reading) { toast(body, 'No reading yet — pull the laser trigger first.', '#F59E0B'); return; }
          d[key] = String(reading.feet);
          input.value = d[key];
          if (key === 'length' || key === 'width' || key === 'linearFeet') recalc(d, inputs);
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

  // Start a guided auto-measure run bound to the current draft. Accepted
  // readings flow straight into the same length/width fields the tech would
  // otherwise type, so "Save room" works identically afterwards.
  function startAutoMeasure(d) {
    if (!seqEngine() || !ble()) return;
    state.seq = seqEngine().create({
      ble: ble(),
      minConfidence: 0.85,
      onUpdate: (st) => {
        if (st.results.length && st.results.length.feet != null) d.length = String(st.results.length.feet);
        if (st.results.width && st.results.width.feet != null) d.width = String(st.results.width.feet);
        if (st.squareFeet != null && !d.manualOverride) d.squareFeet = String(st.squareFeet);
        render();
      }
    });
    state.seq.start();
    render();
  }

  function fmtStep(r) { return r && r.feet != null ? r.feet + ' ft' : '—'; }

  function autoPanel() {
    const ui = U();
    const st = state.seq.getState();
    const wrap = ui.el('div', { className: 'aaa-form' });
    if (st.status === 'complete') {
      wrap.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>✅ Auto-measure complete</strong><div class="aaa-list-sub">L ' + fmtStep(st.results.length) +
        ' · W ' + fmtStep(st.results.width) + (st.squareFeet != null ? ' · ' + st.squareFeet + ' sq ft' : '') + '</div>' }));
      wrap.appendChild(ui.button({ label: 'Done', icon: '✅', variant: 'success', full: true, onClick: () => { stopSeq(); render(); } }));
      return wrap;
    }
    const stepLabel = st.step ? st.step.label : '';
    wrap.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>Auto-measure: ' + esc(stepLabel) + ' (' + (st.index + 1) + '/' + st.total + ')</strong>' +
      '<div class="aaa-list-sub">' + (st.canRemoteTrigger ? 'Auto-firing the laser…' : 'Pull the laser trigger to capture ' + esc(stepLabel) + '.') + '</div>' }));
    if (st.status === 'low-confidence' && st.pending) {
      wrap.appendChild(ui.el('div', { className: 'aaa-list-sub', html: '⚠ Low confidence: ' + st.pending.feet + ' ft (' + Math.round((st.pending.confidence || 0) * 100) + '%). Retake, or use it anyway.' }));
      wrap.appendChild(ui.button({ label: 'Retake', icon: '↻', variant: 'secondary', full: true, onClick: () => { state.seq.retake(); render(); } }));
      wrap.appendChild(ui.button({ label: 'Use anyway (override)', icon: '⚠️', variant: 'ghost', full: true, onClick: () => { state.seq.accept(); render(); } }));
    } else if (st.canRemoteTrigger) {
      wrap.appendChild(ui.button({ label: 'Trigger now', icon: '📡', variant: 'secondary', full: true, onClick: () => { state.seq.trigger(); render(); } }));
    }
    wrap.appendChild(ui.button({ label: 'Skip step', icon: '⏭', variant: 'ghost', size: 'sm', onClick: () => { state.seq.skip(); render(); } }));
    wrap.appendChild(ui.button({ label: 'Cancel auto-measure', icon: '✖', variant: 'ghost', size: 'sm', onClick: () => { stopSeq(); render(); } }));
    return wrap;
  }

  async function saveDraft(body) {
    stopSeq();
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
    if (quote()) body.appendChild(ui.button({ label: 'Send to quote', icon: '🧾', variant: 'primary', full: true, onClick: () => go('quote') }));
    body.appendChild(navRow([{ label: 'History', onClick: () => go('history') }, { label: 'Close', onClick: () => state.sheet.close() }]));
  }

  // ---- 6. Send measurements to Quote OS --------------------------------
  async function renderSendToQuote(body) {
    const ui = U();
    body.appendChild(title('Send to Quote'));
    const sessions = await store().listSessions({ jobId: state.jobId });
    const result = quote() ? await quote().preview({ jobId: state.jobId, customerId: state.customerId, sessions }) : { ok: false, error: 'Quote integration unavailable.' };
    if (!result.ok) { body.appendChild(ui.el('p', { className: 'aaa-empty', text: result.error || 'Cannot create quote preview.' })); body.appendChild(navRow([{ label: 'Back', onClick: () => go('review') }])); return; }
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + result.roomCount + ' room(s) · ' + result.totalSqFt + ' ft²</strong>' +
      '<div class="aaa-list-sub">Draft quote total: $' + result.customerTotal + ' · margin ' + result.marginPercent + '%</div>' }));
    body.appendChild(ui.button({ label: 'Create draft quote', icon: '✅', variant: 'primary', full: true, onClick: async () => {
      const saved = await quote().createDraft({ jobId: state.jobId, customerId: state.customerId, sessions });
      if (!saved.ok) toast(body, saved.error || 'Could not create quote.', '#EF4444');
      else toast(body, 'Draft quote created.', '#10B981');
    } }));
    body.appendChild(navRow([{ label: 'Back', onClick: () => go('review') }, { label: 'Close', onClick: () => state.sheet.close() }]));
  }

  // ---- 7. History -------------------------------------------------------
  async function renderHistory(body) {
    const ui = U();
    body.appendChild(title('Measurement History'));
    const sessions = await store().listSessions({ jobId: state.jobId });
    if (!sessions.length) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No saved measurements for this job yet.' }));
    sessions.forEach((s) => body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(s.roomName) + '</strong><div class="aaa-list-sub">' + (s.squareFeet != null ? s.squareFeet + ' ft² · ' : '') + esc(fmt(s.createdAt)) + '</div>' })));
    body.appendChild(navRow([{ label: 'Setup', onClick: () => go('setup') }, { label: 'Review', onClick: () => go('review') }]));
  }

  // ---- 8. Troubleshooting / Manual -------------------------------------
  function renderTroubleshooting(body) {
    const ui = U();
    body.appendChild(title('Troubleshooting / Manual Mode'));
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>Manual entry always works</strong><div class="aaa-list-sub">Use it if Bluetooth permission is blocked, the device is asleep, or you are offline.</div>' }));
    body.appendChild(ui.button({ label: 'Enter measurements manually', icon: '✍️', variant: 'primary', full: true, onClick: startManualCapture }));
    body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'For Chrome on Android: ensure Bluetooth is enabled, Location is on if your device requires it, and the laser is awake before scanning.' }));
    body.appendChild(navRow([{ label: 'Setup', onClick: () => go('setup') }, { label: 'Close', onClick: () => state.sheet.close() }]));
  }

  async function runAIReview(body, sessions) {
    const ui = U();
    if (!sessions.length) { toast(body, 'No rooms to review.', '#F59E0B'); return; }
    const res = await ai().review({ sessions });
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>AI measurement review</strong><div class="aaa-list-sub">Confidence ' + Math.round((res.confidence || 0) * 100) + '%</div>' +
      (res.notes ? '<div class="aaa-list-sub">' + esc(res.notes.join(' · ')) + '</div>' : '') }));
  }

  function toast(body, msg, color) {
    const ui = U();
    const node = ui.el('p', { className: 'aaa-empty', style: { color: color || '#A1A1AA' }, text: msg || '' });
    body.appendChild(node);
    setTimeout(() => { try { node.remove(); } catch (_) {} }, 3000);
  }

  function fmt(v) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v || '') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  global.AAA_MEASUREMENT_HUD_UI = { boot };
})(typeof window !== 'undefined' ? window : this);
