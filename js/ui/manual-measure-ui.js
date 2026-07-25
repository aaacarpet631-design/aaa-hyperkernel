/*
 * AAA Manual Measure — type a room's dimensions when there is no laser and no
 * camera: the tape-measure path onto the Field Mode start screen.
 *
 * Thin UI over the SAME capture spine the laser uses: rooms are saved through
 * AAA_FIELD_CAPTURE_SESSION.addRoom (→ measurement store + models, source
 * 'manual'), so everything downstream — Field Brain aggregation, material
 * plan, quote drafts, attach-to-job — works identically whether the numbers
 * came from Bluetooth or a keyboard.
 *
 * buildRoom() is a pure, DOM-free validator (testable); saveRoom() persists
 * through the capture session (created lazily on first save, so cancelling an
 * empty form leaves no orphan sessions); open() renders the mobile overlay
 * only when a document exists. Honest by construction: no capture module →
 * CAPTURE_UNAVAILABLE, bad numbers name the field, nothing throws.
 *
 * PRECISION (when AAA_MEASUREMENT_PRECISION is loaded): dimension fields
 * accept tape notation — 12'6", 12 ft 6 in, 150", 3.8m — parsed exactly
 * instead of a tech converting to decimals in their head; the overlay shows a
 * live ft² preview; and before saving, the room runs through the models'
 * field-safety check (misfire / unrealistic / duplicate warnings) — a save
 * with warnings requires an explicit "Save anyway" (opts.force). Without the
 * engine everything degrades to the plain decimal-feet path.
 */
;(function (global) {
  'use strict';

  function fcs() { return global.AAA_FIELD_CAPTURE_SESSION; }
  function precision() { return global.AAA_MEASUREMENT_PRECISION; }

  function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : NaN; // NaN = provided but not a number (an error, not an omission)
  }

  // Tape-notation parse when the precision engine is present; decimal fallback.
  function parseDim(v) {
    const eng = precision();
    if (eng && eng.parseLength) {
      const r = eng.parseLength(v);
      if (r.ok) return r.feet;
      return r.error === 'EMPTY' ? null : NaN;
    }
    return numOrNull(v);
  }
  // Note: the overlay's HTML is fully static; user input only ever flows
  // through input .value reads and textContent writes — never innerHTML.

  const Manual = {
    /**
     * Pure validation: turn form input into an addRoom()-ready room.
     * Valid when it carries real geometry: length AND width, or linearFeet,
     * or stairsCount. One of length/width without the other is refused.
     * input: { roomName?, length?, width?, linearFeet?, stairsCount? }
     */
    buildRoom(input) {
      const i = input || {};
      const length = parseDim(i.length);
      const width = parseDim(i.width);
      const linearFeet = parseDim(i.linearFeet);
      const stairs = numOrNull(i.stairsCount);
      const bad = [];
      if (length != null && (isNaN(length) || length <= 0)) bad.push('length');
      if (width != null && (isNaN(width) || width <= 0)) bad.push('width');
      if (linearFeet != null && (isNaN(linearFeet) || linearFeet <= 0)) bad.push('linearFeet');
      if (stairs != null && (isNaN(stairs) || stairs < 0 || stairs !== Math.floor(stairs))) bad.push('stairsCount');
      if (bad.length) return { ok: false, error: 'INVALID_DIMENSION', fields: bad };
      if ((length != null) !== (width != null)) return { ok: false, error: 'NEED_BOTH_DIMENSIONS' };
      const hasArea = length != null && width != null;
      const hasLinear = linearFeet != null;
      const hasStairs = stairs != null && stairs > 0;
      if (!hasArea && !hasLinear && !hasStairs) return { ok: false, error: 'NO_DIMENSIONS' };
      // 3-decimal feet (≈1/32″) so the parser's tape-notation precision survives.
      const room = { source: 'manual', stairsCount: hasStairs ? stairs : 0 };
      const name = String(i.roomName == null ? '' : i.roomName).trim().slice(0, 60);
      if (name) room.roomName = name;
      if (hasArea) { room.length = Math.round(length * 1000) / 1000; room.width = Math.round(width * 1000) / 1000; }
      if (hasLinear) room.linearFeet = Math.round(linearFeet * 1000) / 1000;
      return { ok: true, room: room };
    },

    /**
     * Validate + persist one room. When sessionId is absent a Field Capture
     * Session is started first (lazily — only for a valid room). When the
     * precision engine is loaded the room first runs the models' field-safety
     * check: warnings (misfire / unrealistic / duplicate) come back as
     * { ok:false, error:'CONFIRM_WARNINGS', warnings } until the caller
     * retries with opts.force — precision means catching mistakes BEFORE they
     * are in a quote. Returns { ok, sessionId, room, session } or an honest error.
     */
    async saveRoom(sessionId, input, opts) {
      const o = opts || {};
      const built = this.buildRoom(input);
      if (!built.ok) return built;
      const s = fcs();
      if (!s || !s.addRoom) return { ok: false, error: 'CAPTURE_UNAVAILABLE', reason: 'field capture session module not loaded' };
      const eng = precision();
      if (eng && eng.check && o.force !== true) {
        let existing = [];
        if (sessionId && s.rooms) { try { existing = await s.rooms(sessionId); } catch (_) { existing = []; } }
        const chk = eng.check(built.room, { existing: existing });
        if (chk && Array.isArray(chk.warnings) && chk.warnings.length) {
          return { ok: false, error: 'CONFIRM_WARNINGS', warnings: chk.warnings, room: built.room };
        }
      }
      let sid = sessionId || null;
      if (!sid) {
        try { const started = await s.start({ customerId: o.customerId || null, jobId: o.jobId || null }); sid = started && started.id; } catch (_) { sid = null; }
        if (!sid) return { ok: false, error: 'SESSION_START_FAILED' };
      }
      const added = await s.addRoom(sid, built.room);
      if (!added.ok) return added;
      return { ok: true, sessionId: sid, room: added.room, session: added.session };
    },

    /** Running totals for the overlay footer (null-tolerant). */
    async summary(sessionId) {
      const s = fcs();
      if (!sessionId || !s || !s.summarize) return null;
      try { return await s.summarize(sessionId); } catch (_) { return null; }
    },

    /**
     * Open the manual-entry overlay (DOM-guarded). opts: { fieldSessionId?,
     * jobId?, customerId?, onDone?(sessionId) }. The session is created on the
     * first successful save, not on open.
     */
    open(opts) {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const o = opts || {};
      const self = this;
      let sessionId = o.fieldSessionId || null;
      let saved = 0;

      if (!document.getElementById('manual-measure-style')) {
        const st = document.createElement('style');
        st.id = 'manual-measure-style';
        st.textContent =
          '#manual-measure{position:fixed;inset:0;background:rgba(10,14,20,.72);z-index:1200;display:flex;align-items:flex-end;justify-content:center}' +
          '#manual-measure .mm-card{background:var(--surface,#fff);color:inherit;border-radius:16px 16px 0 0;padding:1rem 1rem 1.4rem;width:100%;max-width:480px;box-shadow:0 -6px 30px rgba(0,0,0,.35)}' +
          '#manual-measure h3{margin:0 0 .2rem;font-size:1.05rem}' +
          '#manual-measure .mm-sub{margin:0 0 .8rem;font-size:.8rem;opacity:.7}' +
          '#manual-measure .mm-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}' +
          '#manual-measure label{display:flex;flex-direction:column;font-size:.75rem;gap:.25rem}' +
          '#manual-measure label.mm-full{grid-column:1/-1}' +
          '#manual-measure input{padding:.55rem .6rem;border:1px solid rgba(127,127,127,.4);border-radius:8px;font-size:1rem;background:transparent;color:inherit}' +
          '#manual-measure .mm-preview{min-height:1rem;font-size:.85rem;font-weight:600;margin:.5rem 0 0;opacity:.85}' +
          '#manual-measure .mm-msg{min-height:1.1rem;font-size:.78rem;margin:.5rem 0 0}' +
          '#manual-measure .mm-msg--err{color:#e5484d}#manual-measure .mm-msg--ok{color:#30a46c}' +
          '#manual-measure .mm-actions{display:flex;gap:.6rem;margin-top:.8rem}' +
          '#manual-measure button{flex:1;padding:.7rem;border-radius:10px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font-size:.95rem}' +
          '#manual-measure .mm-save{background:#2f6fed;border-color:#2f6fed;color:#fff;font-weight:600}' +
          '#manual-measure .mm-total{font-size:.78rem;opacity:.75;margin-top:.6rem}';
        document.head.appendChild(st);
      }

      const prior = document.getElementById('manual-measure');
      if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
      const overlay = document.createElement('div');
      overlay.id = 'manual-measure';
      overlay.innerHTML =
        '<div class="mm-card">' +
        '<h3>✏️ Manual measurement</h3>' +
        '<p class="mm-sub">Tape-measure entry — saves into the same capture session the laser uses.</p>' +
        '<div class="mm-grid">' +
        '<label class="mm-full">Room name<input class="mm-name" type="text" placeholder="Living room" maxlength="60"></label>' +
        (precision()
          ? '<label>Length<input class="mm-len" type="text" inputmode="text" placeholder="12\'6&quot;"></label>' +
            '<label>Width<input class="mm-wid" type="text" inputmode="text" placeholder="10\'4&quot;"></label>' +
            '<label>Linear feet (optional)<input class="mm-lin" type="text" inputmode="text" placeholder="14 or 14\'6&quot;"></label>'
          : '<label>Length (ft)<input class="mm-len" type="number" inputmode="decimal" min="0" step="0.1"></label>' +
            '<label>Width (ft)<input class="mm-wid" type="number" inputmode="decimal" min="0" step="0.1"></label>' +
            '<label>Linear feet (optional)<input class="mm-lin" type="number" inputmode="decimal" min="0" step="0.1"></label>') +
        '<label>Stairs (steps)<input class="mm-stairs" type="number" inputmode="numeric" min="0" step="1"></label>' +
        '</div>' +
        '<p class="mm-preview"></p>' +
        '<p class="mm-msg"></p>' +
        '<div class="mm-actions"><button type="button" class="mm-save">Save room</button><button type="button" class="mm-done">Done</button></div>' +
        '<div class="mm-total"></div>' +
        '</div>';

      const q = function (sel) { return overlay.querySelector(sel); };
      const msg = q('.mm-msg');
      const total = q('.mm-total');
      const preview = q('.mm-preview');
      let forceNext = false; // set after warnings are shown; next save is "Save anyway"
      const ERR = {
        NO_DIMENSIONS: 'Enter length × width, linear feet, or stairs.',
        NEED_BOTH_DIMENSIONS: 'Enter BOTH length and width (or use linear feet).',
        INVALID_DIMENSION: precision() ? 'Couldn’t read a measurement — try 12\'6", 150", 3.8m, or plain feet.' : 'Those numbers don’t look right — positive numbers only.',
        CAPTURE_UNAVAILABLE: 'Measurement capture module isn’t loaded.',
        SESSION_START_FAILED: 'Could not start a capture session.'
      };

      // Live ft² preview: parse both dims as typed, echo the tape reading back.
      function refreshPreview() {
        const eng = precision();
        preview.textContent = '';
        if (!eng || !eng.parseLength) return;
        const L = eng.parseLength(q('.mm-len').value);
        const W = eng.parseLength(q('.mm-wid').value);
        if (L.ok && W.ok) preview.textContent = '= ' + (Math.round(L.feet * W.feet * 100) / 100) + ' ft²  (' + L.display + ' × ' + W.display + ')';
        else if (L.ok && !q('.mm-wid').value) preview.textContent = L.display + ' × …';
      }
      function resetForce() {
        if (!forceNext) return;
        forceNext = false;
        q('.mm-save').textContent = 'Save room';
      }

      async function refreshTotal() {
        const sum = await self.summary(sessionId);
        total.textContent = (sum && sum.status === 'derived')
          ? saved + ' room(s) saved · ' + sum.totalSquareFeet + ' ft² · ' + sum.totalStairs + ' stairs'
          : (saved ? saved + ' room(s) saved' : '');
      }

      q('.mm-save').onclick = async function () {
        msg.className = 'mm-msg'; msg.textContent = '';
        const res = await self.saveRoom(sessionId, {
          roomName: q('.mm-name').value, length: q('.mm-len').value, width: q('.mm-wid').value,
          linearFeet: q('.mm-lin').value, stairsCount: q('.mm-stairs').value
        }, { jobId: o.jobId || null, customerId: o.customerId || null, force: forceNext });
        if (!res.ok && res.error === 'CONFIRM_WARNINGS') {
          forceNext = true;
          q('.mm-save').textContent = 'Save anyway';
          msg.className = 'mm-msg mm-msg--err';
          msg.textContent = '⚠ ' + res.warnings.join(' ') + ' Fix it, or tap Save anyway.';
          return;
        }
        if (!res.ok) { msg.className = 'mm-msg mm-msg--err'; msg.textContent = ERR[res.error] || ('Could not save (' + res.error + ').'); return; }
        resetForce();
        sessionId = res.sessionId; saved++;
        msg.className = 'mm-msg mm-msg--ok'; msg.textContent = 'Saved ' + (res.room.roomName || 'room') + ' ✓ — add the next room or tap Done.';
        ['.mm-name', '.mm-len', '.mm-wid', '.mm-lin', '.mm-stairs'].forEach(function (s2) { q(s2).value = ''; });
        preview.textContent = '';
        q('.mm-name').focus();
        await refreshTotal();
      };
      ['.mm-len', '.mm-wid', '.mm-lin', '.mm-stairs', '.mm-name'].forEach(function (sel) {
        q(sel).addEventListener('input', function () { resetForce(); refreshPreview(); });
      });
      q('.mm-done').onclick = function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (typeof o.onDone === 'function') { try { o.onDone(sessionId); } catch (_) {} }
      };
      overlay.onclick = function (e) { if (e.target === overlay) q('.mm-done').onclick(); };

      document.body.appendChild(overlay);
      try { q('.mm-len').focus(); } catch (_) {}
      refreshTotal();
      return { opened: true, sessionId: sessionId };
    }
  };

  global.AAA_MANUAL_MEASURE_UI = Manual;
})(typeof window !== 'undefined' ? window : this);
