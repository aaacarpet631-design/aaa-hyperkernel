/*
 * AAA Field Mode Home — land in a Field Mode OS, not a project-management screen.
 *
 * The first thing a tech sees walking into a house is one big action: START
 * MEASUREMENT. Below it, quick actions (Scan Room / Laser / Manual Entry /
 * Quick Estimate / Voice Note) wired to the REAL capabilities that exist —
 * each honestly marked available:false when its engine isn't loaded. START
 * MEASUREMENT prefers the laser HUD and falls back to manual (tape-measure)
 * entry, so the button always leads somewhere real. Today's jobs go BELOW the
 * action, not above. "Ask HyperKernel" sits at the bottom.
 *
 * renderModel() is a pure, DOM-free read model (testable); mount() renders the
 * mobile screen only when a document exists; start() routes to the real flows.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function has(name) { return !!global['AAA_' + name]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }

  function greetingFor(now) {
    const h = new Date(now == null ? nowMs() : now).getHours();
    return h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
  }
  function ownerName() { const c = cfg(); return (c.flag && c.flag('ownerName', null)) || c.ownerName || (c.businessName ? c.businessName.replace(/\s*(carpet|flooring).*$/i, '').trim() : '') || 'there'; }

  // quick action → which global hosts it (target) + the method that launches it
  // (entry). `needs` is what must exist for the card to be live.
  const QUICK = [
    { id: 'scan_room', icon: '📷', label: 'Scan Room', needs: ['VISION_HUD_UI', 'CAPTURE_SEQUENCER'], boot: 'VISION_HUD_UI', entry: 'boot' },
    { id: 'laser_measure', icon: '📐', label: 'Laser Measure', needs: ['MEASUREMENT_HUD_UI', 'BLUETOOTH', 'DEVICE_ADAPTER_REGISTRY'], boot: 'MEASUREMENT_HUD_UI', entry: 'boot' },
    { id: 'manual_measure', icon: '✏️', label: 'Manual Entry', needs: ['MANUAL_MEASURE_UI'], boot: 'MANUAL_MEASURE_UI', entry: 'open' },
    { id: 'quick_estimate', icon: '📝', label: 'Quick Estimate', needs: ['ESTIMATOR_UI'], boot: 'ESTIMATOR_UI', entry: 'open' },
    { id: 'voice_note', icon: '🎤', label: 'Voice Note', needs: ['VOICE_HUD_UI'], boot: 'VOICE_HUD_UI', entry: 'open' }
  ];
  function actionAvailable(a) { return a.needs.some(has); }

  const Home = {
    QUICK_ACTIONS: QUICK.map(function (a) { return a.id; }),

    /** Today's active/scheduled jobs (newest first, capped). */
    async todaysJobs(opts) {
      const o = opts || {};
      let jobs = [];
      try { jobs = (await data().list('jobs')) || []; } catch (_) { jobs = []; }
      const active = jobs.filter(function (j) { const s = String(j.currentState || j.status || '').toUpperCase(); return s !== 'CLOSED' && s !== 'LOST'; });
      return active.slice(0, o.limit || 6).map(function (j) { return { id: j.id, label: j.customerName || j.name || j.address || 'Job', state: j.currentState || j.status || 'active', address: j.address || null }; });
    },

    /** Pure render model for the Field Mode home. */
    async renderModel(opts) {
      const o = opts || {};
      return {
        greeting: greetingFor(o.now) + ', ' + ownerName(),
        primaryAction: { id: 'start_measurement', label: 'START MEASUREMENT', icon: '📐', available: has('MEASUREMENT_HUD_UI') || has('CAPTURE_SEQUENCER') || has('MANUAL_MEASURE_UI') },
        quickActions: QUICK.map(function (a) { return { id: a.id, icon: a.icon, label: a.label, available: actionAvailable(a) }; }),
        todaysJobs: await this.todaysJobs(o),
        ask: { prompt: 'Ask HyperKernel', placeholder: 'What should I focus on?' }
      };
    },

    /**
     * Begin a job-optional Field Capture Session (measure rooms first, attach to
     * a job later), then open the measurement HUD bound to it when present —
     * falling back to MANUAL ENTRY when no laser HUD is loaded, so START
     * MEASUREMENT always leads somewhere real.
     */
    async start(opts) {
      const o = opts || {};
      let sessionId = null;
      const fcs = global.AAA_FIELD_CAPTURE_SESSION;
      if (fcs && fcs.start) { try { const s = await fcs.start({ customerId: o.customerId || null, jobId: o.jobId || null }); sessionId = s && s.id; } catch (_) {} }
      const hud = global.AAA_MEASUREMENT_HUD_UI;
      if (hud && hud.boot && typeof document !== 'undefined') { hud.boot({ jobId: o.jobId || null, customerId: o.customerId || null, fieldSessionId: sessionId }); return { ok: true, routed: true, via: 'measurement_hud', sessionId: sessionId }; }
      const manual = global.AAA_MANUAL_MEASURE_UI;
      if (manual && manual.open && typeof document !== 'undefined') { manual.open({ jobId: o.jobId || null, customerId: o.customerId || null, fieldSessionId: sessionId }); return { ok: true, routed: true, via: 'manual_measure', sessionId: sessionId }; }
      return { ok: !!sessionId, routed: false, via: sessionId ? 'field_capture_session' : null, sessionId: sessionId, reason: sessionId ? (typeof document === 'undefined' ? 'no_dom' : 'no_hud') : 'measurement_unavailable' };
    },

    /** Run a quick action by id; routes to the real engine when present. */
    startQuick(id, opts) {
      const a = QUICK.filter(function (x) { return x.id === id; })[0];
      if (!a) return { ok: false, reason: 'UNKNOWN_ACTION' };
      if (!actionAvailable(a)) return { ok: false, routed: false, reason: 'unavailable', action: id };
      const target = global['AAA_' + a.boot];
      // Honor the action's declared entry, then fall back to whatever launch
      // method the target actually exposes (HUDs use boot, panels use open).
      const fn = target && (target[a.entry] || target.boot || target.open || target.start);
      if (typeof fn === 'function' && typeof document !== 'undefined') { fn.call(target, (opts || {})); return { ok: true, routed: true, via: a.boot, entry: a.entry }; }
      return { ok: true, routed: false, via: a.boot, reason: (typeof document === 'undefined' ? 'no_dom' : 'no_boot') };
    },

    /** Render the mobile Field Mode home into a DOM element (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body; const self = this;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div'); wrap.className = 'fm-home';
      wrap.innerHTML =
        '<h2 class="fm-greeting">' + esc(m.greeting) + '</h2>' +
        '<button class="fm-primary" type="button">' + esc(m.primaryAction.icon) + ' ' + esc(m.primaryAction.label) + '</button>' +
        '<div class="fm-quick">' + m.quickActions.map(function (q) { return '<button class="fm-q' + (q.available ? '' : ' fm-q--off') + '" data-q="' + esc(q.id) + '">' + esc(q.icon) + '<span>' + esc(q.label) + '</span></button>'; }).join('') + '</div>' +
        '<h3 class="fm-sec">Today\'s Jobs</h3>' +
        '<div class="fm-jobs">' + (m.todaysJobs.length ? m.todaysJobs.map(function (j) { return '<div class="fm-job" data-job="' + esc(j.id) + '">' + esc(j.label) + ' · ' + esc(j.state) + '</div>'; }).join('') : '<div class="fm-empty">No active jobs — tap START MEASUREMENT to begin.</div>') + '</div>' +
        '<button class="fm-ask" type="button">🤖 ' + esc(m.ask.prompt) + ' — "' + esc(m.ask.placeholder) + '"</button>';
      wrap.querySelector('.fm-primary').onclick = function () { self.start(opts); };
      wrap.querySelectorAll('.fm-q').forEach(function (b) { b.onclick = function () { self.startQuick(b.getAttribute('data-q'), opts); }; });
      const ask = wrap.querySelector('.fm-ask'); ask.onclick = function () { if (global.AAA_JOB_LIST_UI && global.AAA_JOB_LIST_UI._switchTab) global.AAA_JOB_LIST_UI._switchTab('chat'); };
      root.appendChild(wrap);
      return { mounted: true };
    }
  };

  global.AAA_FIELD_MODE_HOME = Home;
})(typeof window !== 'undefined' ? window : this);
