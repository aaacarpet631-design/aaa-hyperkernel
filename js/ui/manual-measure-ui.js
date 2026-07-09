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
 */
;(function (global) {
  'use strict';

  function fcs() { return global.AAA_FIELD_CAPTURE_SESSION; }

  function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : NaN; // NaN = provided but not a number (an error, not an omission)
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
      const length = numOrNull(i.length);
      const width = numOrNull(i.width);
      const linearFeet = numOrNull(i.linearFeet);
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
      const room = { source: 'manual', stairsCount: hasStairs ? stairs : 0 };
      const name = String(i.roomName == null ? '' : i.roomName).trim().slice(0, 60);
      if (name) room.roomName = name;
      if (hasArea) { room.length = Math.round(length * 100) / 100; room.width = Math.round(width * 100) / 100; }
      if (hasLinear) room.linearFeet = Math.round(linearFeet * 100) / 100;
      return { ok: true, room: room };
    },

    /**
     * Validate + persist one room. When sessionId is absent a Field Capture
     * Session is started first (lazily — only for a valid room). Returns
     * { ok, sessionId, room, session } or an honest error.
     */
    async saveRoom(sessionId, input, opts) {
      const built = this.buildRoom(input);
      if (!built.ok) return built;
      const s = fcs();
      if (!s || !s.addRoom) return { ok: false, error: 'CAPTURE_UNAVAILABLE', reason: 'field capture session module not loaded' };
      let sid = sessionId || null;
      if (!sid) {
        const o = opts || {};
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
        '<label>Length (ft)<input class="mm-len" type="number" inputmode="decimal" min="0" step="0.1"></label>' +
        '<label>Width (ft)<input class="mm-wid" type="number" inputmode="decimal" min="0" step="0.1"></label>' +
        '<label>Linear feet (optional)<input class="mm-lin" type="number" inputmode="decimal" min="0" step="0.1"></label>' +
        '<label>Stairs (steps)<input class="mm-stairs" type="number" inputmode="numeric" min="0" step="1"></label>' +
        '</div>' +
        '<p class="mm-msg"></p>' +
        '<div class="mm-actions"><button type="button" class="mm-save">Save room</button><button type="button" class="mm-done">Done</button></div>' +
        '<div class="mm-total"></div>' +
        '</div>';

      const q = function (sel) { return overlay.querySelector(sel); };
      const msg = q('.mm-msg');
      const total = q('.mm-total');
      const ERR = {
        NO_DIMENSIONS: 'Enter length × width, linear feet, or stairs.',
        NEED_BOTH_DIMENSIONS: 'Enter BOTH length and width (or use linear feet).',
        INVALID_DIMENSION: 'Those numbers don’t look right — positive numbers only.',
        CAPTURE_UNAVAILABLE: 'Measurement capture module isn’t loaded.',
        SESSION_START_FAILED: 'Could not start a capture session.'
      };

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
        }, { jobId: o.jobId || null, customerId: o.customerId || null });
        if (!res.ok) { msg.className = 'mm-msg mm-msg--err'; msg.textContent = ERR[res.error] || ('Could not save (' + res.error + ').'); return; }
        sessionId = res.sessionId; saved++;
        msg.className = 'mm-msg mm-msg--ok'; msg.textContent = 'Saved ' + (res.room.roomName || 'room') + ' ✓ — add the next room or tap Done.';
        ['.mm-name', '.mm-len', '.mm-wid', '.mm-lin', '.mm-stairs'].forEach(function (s2) { q(s2).value = ''; });
        q('.mm-name').focus();
        await refreshTotal();
      };
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
