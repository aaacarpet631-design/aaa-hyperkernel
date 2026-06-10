/* Field Mode quick actions + Voice HUD entry — regression coverage for the
 * "Quick Estimate / Voice Note don't work" report.
 *
 * Three real bugs are guarded here:
 *   1. voice-hud-ui called renderActions() — a function that never existed —
 *      so tapping the mic with no active job threw ReferenceError and tripped
 *      the app's global error boundary ("Startup failed").
 *   2. the Voice Note quick action called boot() (wiring-only) instead of an
 *      entry that actually opens the panel.
 *   3. Quick Estimate routed to AAA_QUOTES (a data store, no UI entry) instead
 *      of the estimator UI; startQuick also hardcoded .boot() when most panels
 *      expose .open().
 *
 * This UI layer is DOM-gated, so we install a minimal document stub. The runner
 * gives every suite its own process, so the stub never leaks. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (enough to drive the voice HUD + field home) ---------
function makeEl() {
  const e = {
    _text: '', style: {}, className: '', value: '', children: [],
    classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; }, toggle(c, on) { const v = on === undefined ? !this._s[c] : !!on; if (v) this._s[c] = true; else delete this._s[c]; return v; } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { e.children.push(c); return c; },
    insertBefore(c) { e.children.unshift(c); return c; },
    removeChild(c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); return c; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}
  };
  Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = v; } });
  Object.defineProperty(e, 'firstChild', { get() { return e.children[0] || null; } });
  Object.defineProperty(e, 'parentNode', { get() { return null; } });
  return e;
}
function installDom() {
  const byId = {};
  global.document = {
    createElement: () => makeEl(),
    getElementById: (id) => (byId[id] || (byId[id] = makeEl())),
    body: makeEl(),
    _byId: byId
  };
  return global.document;
}

module.exports = async function run() {
  const t = makeRunner('field-quick-actions');
  const { G } = setupEnv();
  const doc = installDom();
  try {
    load('js/ui/voice-hud-ui.js');
    load('js/ui/field-mode-home.js');
    const VOICE = G.AAA_VOICE_HUD_UI, HOME = G.AAA_FIELD_MODE_HOME;

    // ===== Voice HUD exposes a real open() entry (boot is wiring-only) =====
    t.ok('voice HUD exposes open() and boot()', typeof VOICE.open === 'function' && typeof VOICE.boot === 'function');

    // ===== Bug 1: opening with no active job must NOT throw (renderActions) ==
    let threw = null;
    try { VOICE.open({}); } catch (e) { threw = e; }
    t.ok('opening the voice HUD with no job does not throw (renderActions gone)', threw === null);
    t.ok('the voice overlay is actually shown (not a silent no-op)', doc.getElementById('voice-overlay').classList.contains('visible'));

    // ===== Bug 2: Voice Note quick action routes via open(), not boot() =====
    let voiceOpened = 0, voiceBootedOnly = 0;
    G.AAA_VOICE_HUD_UI = { boot: function () { voiceBootedOnly++; }, open: function () { voiceOpened++; } };
    const rVoice = HOME.startQuick('voice_note', {});
    t.ok('voice_note is routed', rVoice.ok === true && rVoice.routed === true);
    t.eq('voice_note uses the open entry', rVoice.entry, 'open');
    t.ok('voice_note actually called open() (and not just boot())', voiceOpened === 1 && voiceBootedOnly === 0);

    // ===== Bug 3: Quick Estimate routes to the estimator UI via open() ======
    let estOpened = 0;
    G.AAA_ESTIMATOR_UI = { open: function () { estOpened++; } };
    const rEst = HOME.startQuick('quick_estimate', {});
    t.ok('quick_estimate is available once the estimator UI is loaded', rEst.ok === true && rEst.routed === true);
    t.eq('quick_estimate targets the estimator UI', rEst.via, 'ESTIMATOR_UI');
    t.ok('quick_estimate launched the estimator (open called)', estOpened === 1);

    // a bare quote *store* (no open/boot) must NOT be treated as routable
    delete G.AAA_ESTIMATOR_UI;
    const rNoUi = HOME.startQuick('quick_estimate', {});
    t.ok('with no estimator UI, quick_estimate is honestly unavailable', rNoUi.ok === false && rNoUi.reason === 'unavailable');

    // ===== HUD-style actions still route via boot() =========================
    let visionBooted = 0;
    G.AAA_VISION_HUD_UI = { boot: function () { visionBooted++; } };
    const rScan = HOME.startQuick('scan_room', {});
    t.ok('scan_room still routes via boot()', rScan.routed === true && rScan.entry === 'boot' && visionBooted === 1);

    // ===== Bug 4: floating voice FAB must not cover the Chat composer's Send ==
    // The Chat/Focus canvases own the bottom-right corner with their own Send
    // button; the FAB lives in the same corner, so it has to step aside there.
    load('js/ui/job-list-ui.js');
    const APP = G.AAA_JOB_LIST_UI;
    t.ok('job list exposes the FAB visibility toggle', typeof APP._setVoiceFabHidden === 'function');
    APP._setVoiceFabHidden(true);
    t.ok('on chat-style tabs the FAB is hidden so it cannot cover Send', doc.body.classList.contains('hk-hide-voice-fab'));
    APP._setVoiceFabHidden(false);
    t.ok('on every other tab the FAB stays visible for voice logging', !doc.body.classList.contains('hk-hide-voice-fab'));

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
