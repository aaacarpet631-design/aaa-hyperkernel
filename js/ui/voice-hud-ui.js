/*
 * Voice HUD UI — floating mic button + professional diagnostic modal.
 *
 * Replaces the old "No signal. Enter note:" dead-end with a three-layer flow:
 *   Layer 1  tap mic → live recognition (when secure + supported + permitted)
 *   Layer 2  Record Audio Instead → MediaRecorder with a live timer → transcribe
 *   Layer 3  Type Note → manual textarea (always available)
 *
 * On any failure it shows the REAL reason (from AAA_VOICE_DIAGNOSTICS) and the
 * recovery actions: Retry Voice · Record Audio · Type Note · Check Permissions.
 * "No signal" only ever appears for an actual network-offline condition.
 *
 * After a transcript is captured (any layer), it kicks the review-only Job Notes
 * Agent in the background — suggestions attach to the note; nothing auto-applies.
 */
;(function (global) {
  'use strict';

  function diag() { return global.AAA_VOICE_DIAGNOSTICS; }
  function engine() { return global.AAA_SIDEKICK_VOICE; }
  function agent() { return global.AAA_JOB_NOTES_AGENT; }

  function createVoiceHUD() {
    const state = { currentJobId: null, initialized: false, hideTimeout: null, recording: null, timerId: null };
    const els = {};

    function initDOM() {
      els.fab = document.getElementById('voice-fab');
      els.overlay = document.getElementById('voice-overlay');
      els.status = document.getElementById('voice-status');
      els.transcript = document.getElementById('voice-transcript');
      if (!els.fab || !els.overlay || !els.status || !els.transcript) {
        console.error('Voice HUD: required DOM elements not found');
        return;
      }
      els.fab.addEventListener('click', handleClick);
    }

    function clearHide() { if (state.hideTimeout) { clearTimeout(state.hideTimeout); state.hideTimeout = null; } }
    function clearBody() { if (els.body) { els.body.remove(); els.body = null; } }
    function stopTimer() { if (state.timerId) { clearInterval(state.timerId); state.timerId = null; } }

    function setStatus(text, color) {
      els.status.textContent = text || '';
      els.status.style.color = color || '';
    }

    function show() { clearHide(); els.overlay.classList.add('visible'); }
    function hideOverlay(delay) {
      clearHide();
      state.hideTimeout = setTimeout(function () {
        els.overlay.classList.remove('visible');
        els.fab.classList.remove('listening');
        setStatus('', '');
        els.transcript.textContent = '';
        clearBody();
      }, delay || 0);
    }

    // ---- entry: tap the mic ------------------------------------------------
    async function handleClick() {
      clearHide(); clearBody(); els.transcript.textContent = '';
      if (!state.currentJobId) {
        setStatus('No active job', '#D97706');
        els.transcript.textContent = diag() ? diag().message('NO_ACTIVE_JOB') : 'Open a job first.';
        renderActions(['type', 'close']);
        show();
        return;
      }
      const D = diag();
      const a = D ? await D.assess() : { canLive: true, canRecord: false, code: 'OK' };
      // Prefer live recognition when truly available; otherwise go straight to
      // the diagnostic panel with the real reason and the right actions.
      if (a.canLive) { await runLive(); return; }
      showDiagnostic(a.code);
    }

    // ---- Layer 1: live recognition ----------------------------------------
    async function runLive() {
      clearBody();
      setStatus('Listening…', '#DC2626');
      els.transcript.textContent = '';
      els.fab.classList.add('listening');
      show();
      const result = await engine().startListening(state.currentJobId);
      els.fab.classList.remove('listening');
      if (result && result.ok) { onTranscript(result); return; }
      showDiagnostic(result && (result.code || result.error));
    }

    // ---- Layer 2: audio recording -----------------------------------------
    async function runRecord() {
      clearBody();
      setStatus('Preparing recorder…', '#DC2626');
      els.transcript.textContent = '';
      show();
      const ctrl = await engine().recorder(state.currentJobId);
      if (!ctrl || !ctrl.ok) { showDiagnostic(ctrl && ctrl.code); return; }
      state.recording = ctrl;

      // Recording UI: live timer + Stop / Cancel.
      const body = makeBody();
      const timer = el('div', 'voice-timer', '00:00');
      const startMs = Date.now();
      body.appendChild(timer);
      const stopBtn = button('⏹ Stop & Transcribe', 'primary', async function () {
        stopTimer();
        setStatus('Saving & transcribing…', '#DC2626');
        const out = await ctrl.stop();
        state.recording = null;
        const saved = await engine().saveRecording(state.currentJobId, out.blob, { durationMs: out.durationMs });
        if (saved && saved.ok) onTranscript(saved);
        else {
          // Audio is saved even when transcription fails — say so honestly.
          showDiagnostic(saved && saved.code, 'Audio saved to the job. Transcription can be retried later.');
        }
      });
      const cancelBtn = button('Cancel', 'ghost', function () { stopTimer(); try { ctrl.cancel(); } catch (_) {} state.recording = null; hideOverlay(0); });
      body.appendChild(actionsRow([stopBtn, cancelBtn]));
      els.overlay.appendChild(body);
      els.body = body;

      setStatus('Recording…', '#DC2626');
      els.fab.classList.add('listening');
      ctrl.start();
      state.timerId = setInterval(function () {
        const s = Math.floor((Date.now() - startMs) / 1000);
        timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      }, 250);
    }

    // ---- Layer 3: manual note ---------------------------------------------
    function runManual() {
      clearBody();
      setStatus('Type your note', '#F8FAFC');
      els.transcript.textContent = '';
      const body = makeBody();
      const ta = document.createElement('textarea');
      ta.placeholder = 'Type the job note here…';
      ta.className = 'voice-manual-input';
      const saveBtn = button('Save Note', 'primary', async function () {
        const note = ta.value.trim();
        if (!note) { setStatus('Note cannot be empty', '#D97706'); return; }
        const r = await engine().saveTextLog(state.currentJobId, note);
        if (r && r.ok) onTranscript(r);
        else { setStatus((diag() ? diag().message(r && r.code) : 'Error saving note'), '#D97706'); }
      });
      body.appendChild(ta);
      body.appendChild(actionsRow([saveBtn]));
      els.overlay.appendChild(body);
      els.body = body;
      show();
      setTimeout(function () { try { ta.focus(); } catch (_) {} }, 50);
    }

    // ---- diagnostic panel (the professional replacement for "No signal") ---
    async function showDiagnostic(code, extraNote) {
      stopTimer();
      els.fab.classList.remove('listening');
      const D = diag();
      const a = D ? await D.assess() : {};
      const c = code || a.code || 'UNSUPPORTED_BROWSER';

      // Only call it "offline/no signal" when it genuinely is a network issue.
      const isNetwork = c === 'NETWORK_OFFLINE';
      setStatus(isNetwork ? 'Voice offline — no signal' : 'Voice Assistant Offline', '#DC2626');

      clearBody();
      const body = makeBody();
      body.appendChild(el('p', 'voice-reason', (D ? D.message(c) : ('Voice error: ' + c)) + (extraNote ? ' ' + extraNote : '')));

      // Live status lines: permission / browser / secure / network.
      const grid = el('div', 'voice-statusgrid', '');
      grid.appendChild(statusLine('Microphone', permLabel(a.permission), a.permission === 'granted' ? 'ok' : a.permission === 'denied' ? 'bad' : 'warn'));
      grid.appendChild(statusLine('Live recognition', a.speech ? 'Supported' : 'Not supported', a.speech ? 'ok' : 'bad'));
      grid.appendChild(statusLine('Audio recording', a.mediaRecorder ? 'Supported' : 'Not supported', a.mediaRecorder ? 'ok' : 'bad'));
      grid.appendChild(statusLine('Secure (https)', a.secure ? 'Yes' : 'No', a.secure ? 'ok' : 'bad'));
      grid.appendChild(statusLine('Network', a.online ? 'Online' : 'Offline', a.online ? 'ok' : 'warn'));
      body.appendChild(grid);

      // Action buttons, contextual to what's actually possible.
      const acts = [];
      if (a.canLive) acts.push(button('🎤 Retry Voice', 'primary', runLive));
      if (a.canRecord) acts.push(button('⏺ Record Audio Instead', a.canLive ? 'secondary' : 'primary', runRecord));
      acts.push(button('⌨ Type Note', acts.length ? 'secondary' : 'primary', runManual));
      if (a.permission === 'denied' || !a.secure) acts.push(button('🔧 Check Permissions', 'ghost', showPermissionHelp));
      body.appendChild(actionsRow(acts));

      els.overlay.appendChild(body);
      els.body = body;
      show();
    }

    function showPermissionHelp() {
      clearBody();
      setStatus('Check Permissions', '#F8FAFC');
      const body = makeBody();
      const ua = (global.navigator && global.navigator.userAgent) || '';
      const android = /Android/i.test(ua);
      const steps = android
        ? ['Tap the lock/ⓘ icon left of the address bar in Chrome.', 'Open “Permissions” → “Microphone”.', 'Set it to Allow, then return and tap Retry Voice.', 'Make sure the page is loaded over https.']
        : ['Click the lock icon left of the address bar.', 'Find “Microphone” and set it to Allow.', 'Reload if prompted, then tap Retry Voice.', 'Ensure the page is served over https.'];
      const ol = document.createElement('ol'); ol.className = 'voice-help';
      steps.forEach(function (s) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
      body.appendChild(ol);
      body.appendChild(actionsRow([button('🎤 Retry Voice', 'primary', runLive), button('⌨ Type Note', 'secondary', runManual)]));
      els.overlay.appendChild(body);
      els.body = body;
      show();
    }

    // ---- shared: on a successful transcript --------------------------------
    function onTranscript(result) {
      stopTimer();
      els.fab.classList.remove('listening');
      clearBody();
      setStatus('Saved' + (result.source === 'manual' ? '' : (result.confidence ? ' · ' + result.confidence + '% confidence' : '')), '#16A34A');
      els.transcript.textContent = result.transcript || result.text || '';
      // Fire-and-forget review-only AI extraction; never blocks, never auto-acts.
      if (result.noteId && agent() && agent().isReady && agent().isReady()) {
        agent().analyze(result.noteId).catch(function () {});
      }
      hideOverlay(3500);
    }

    // ---- tiny DOM helpers --------------------------------------------------
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function makeBody() { const b = el('div', 'voice-body', ''); return b; }
    function actionsRow(btns) { const r = el('div', 'voice-actions', ''); btns.forEach(function (b) { r.appendChild(b); }); return r; }
    function button(label, variant, onClick) {
      const b = el('button', 'voice-btn voice-btn--' + (variant || 'secondary'), label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }
    function statusLine(k, v, tone) {
      const row = el('div', 'voice-statusline', '');
      row.appendChild(el('span', 'voice-statusline__k', k));
      row.appendChild(el('span', 'voice-statusline__v voice-tone--' + (tone || 'warn'), v));
      return row;
    }
    function permLabel(p) { return p === 'granted' ? 'Allowed' : p === 'denied' ? 'Blocked' : p === 'prompt' ? 'Will ask' : 'Unknown'; }

    return {
      boot: function (opts) {
        state.currentJobId = (opts && opts.jobId) || null;
        if (!state.initialized) { initDOM(); state.initialized = true; }
      },
      updateJobId: function (jobId) { state.currentJobId = jobId; },
      // Exposed for tests / programmatic open.
      _showDiagnostic: showDiagnostic
    };
  }

  global.AAA_VOICE_HUD_UI = createVoiceHUD();
})(typeof window !== 'undefined' ? window : this);
