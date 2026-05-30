/*
 * AAA_CLOSURE_HUD_UI — Departure / closeout screen.
 *
 * Audits the job via AAA_SIDEKICK_CLOSURE, shows a readiness progress bar,
 * an Auto Verification card (icon per item) and a Manual Verification card
 * (custom tappable check rows). "Safe Close" stays disabled until every
 * required item is complete. "Force Close" is a danger action gated behind a
 * confirmation dialog that requires a typed reason, which is logged on the job
 * and in the override mutation.
 */
;(function (global) {
  'use strict';

  // The 9-Point Job Closure System. Every completed job must pass all nine.
  // Items 7 & 8 (before/after photos) are EVIDENCE-GATED: they can only be
  // checked when real photos are attached to the job (auto-detected), so a tech
  // can't claim photo evidence that doesn't exist.
  const CLOSURE_ITEMS = [
    { key: 'seam', label: '1. Seam inspection' },
    { key: 'stretch', label: '2. Stretch verification' },
    { key: 'alignment', label: '3. Carpet alignment check' },
    { key: 'edge', label: '4. Edge finish verification' },
    { key: 'cleanup', label: '5. Cleanup verification' },
    { key: 'walkthrough', label: '6. Customer walkthrough' },
    { key: 'beforePhotos', label: '7. Before photos', evidence: 'photos' },
    { key: 'afterPhotos', label: '8. After photos', evidence: 'photos' },
    { key: 'signoff', label: '9. Final sign-off' }
  ];

  function blankChecks() {
    const c = {}; CLOSURE_ITEMS.forEach((i) => { c[i.key] = false; }); return c;
  }

  const state = {
    jobId: null,
    report: null,
    manualChecks: blankChecks()
  };

  let overlayEl = null;
  let cardEl = null;

  function ui() { return global.AAA_UI; }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'closure-hud';
    overlayEl.className = 'closure-hud hidden';
    cardEl = document.createElement('div');
    cardEl.className = 'closure-card';
    overlayEl.appendChild(cardEl);
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) hideOverlay(); });
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  // Is a given closure item satisfiable? Evidence-gated items require the
  // matching auto-verified evidence to exist before they can be checked.
  function evidenceOk(item) {
    if (!item.evidence) return true;
    const auto = (state.report && state.report.autoVerified) || {};
    return !!auto[item.key];   // beforePhotos / afterPhotos keys mirror item keys
  }

  function render() {
    ensureOverlay();
    const U = ui();
    const rbac = global.AAA_RBAC;
    const canClose = !rbac || rbac.can('COMPLETE_CHECKLIST'); // crew+ may complete
    const canSafeClose = !rbac || rbac.can('CLOSE_JOB');      // but closing needs CLOSE_JOB

    const total = CLOSURE_ITEMS.length;
    const completed = CLOSURE_ITEMS.filter((i) => state.manualChecks[i.key]).length;
    const allChecked = completed === total;
    const readyForSafeClose = allChecked && canSafeClose;

    cardEl.innerHTML = '';
    cardEl.appendChild(U.el('div', { className: 'closure-grip' }));
    cardEl.appendChild(U.el('h1', { className: 'closure-title', text: '9-Point Job Closure' }));
    cardEl.appendChild(U.el('p', { className: 'closure-sub', text: 'Every point must pass before this job can close.' }));

    const bar = U.progressBar(completed, total);
    cardEl.appendChild(U.el('div', { className: 'closure-progress' }, [
      U.el('div', { className: 'closure-progress__row' }, [
        U.el('span', { text: 'Closeout readiness' }),
        U.el('span', { className: 'closure-progress__count', text: completed + '/' + total + ' complete' })
      ]),
      bar.root
    ]));

    // The nine points (tappable; evidence-gated items lock until evidence exists).
    const rows = U.el('div', { className: 'closure-rows' });
    CLOSURE_ITEMS.forEach((m) => {
      const checked = !!state.manualChecks[m.key];
      const locked = !evidenceOk(m);
      const row = U.el('button', {
        className: 'closure-check' + (checked ? ' is-checked' : '') + (locked ? ' is-missing' : ''),
        attrs: { type: 'button', 'aria-pressed': checked ? 'true' : 'false', disabled: (locked || !canClose) ? 'true' : null },
        on: { click: () => {
          if (locked) { return; }                 // can't check photo evidence that doesn't exist
          if (!canClose) { return; }
          state.manualChecks[m.key] = !state.manualChecks[m.key]; render();
        } }
      }, [
        U.el('span', { className: 'closure-check__box', attrs: { 'aria-hidden': 'true' }, text: checked ? '✓' : (locked ? '🔒' : '') }),
        U.el('span', { className: 'closure-check__label', text: m.label + (locked ? ' — attach photos first' : '') })
      ]);
      rows.appendChild(row);
    });
    cardEl.appendChild(section('Required — all 9 points', rows));

    if (!canClose) {
      cardEl.appendChild(U.el('p', { className: 'closure-missing', text: 'Your role can view this checklist but not complete it.' }));
    }

    // actions
    const actions = U.el('div', { className: 'closure-actions' });
    actions.appendChild(U.button({
      label: 'Safe Close & Generate Review Request', variant: 'primary', full: true,
      disabled: !readyForSafeClose, onClick: handleSafeClose,
      ariaLabel: readyForSafeClose ? 'Safe close job' : 'Safe close disabled until all 9 points complete'
    }));
    // Force Close (override) is restricted to roles that may close jobs.
    if (canSafeClose) {
      actions.appendChild(U.button({ label: 'Force Close (Override)', variant: 'danger', full: true, onClick: handleForceClose }));
    }
    actions.appendChild(U.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: hideOverlay }));
    cardEl.appendChild(actions);

    if (!canSafeClose) {
      cardEl.appendChild(U.el('p', { className: 'closure-hint', text: 'Only an owner or manager can close a job. Complete the points; they will close it.' }));
    } else if (!allChecked) {
      cardEl.appendChild(U.el('p', { className: 'closure-hint', text: 'Safe Close unlocks when all 9 points are complete.' }));
    }

    overlayEl.classList.remove('hidden');
  }

  function section(title, rowsEl) {
    return ui().el('section', { className: 'closure-section' }, [
      ui().el('h2', { className: 'closure-section__title', text: title }),
      rowsEl
    ]);
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.classList.add('hidden');
    state.manualChecks = blankChecks();
    state.report = null;
    state.jobId = null;
  }

  // The actual job-state mutation. Wrapped by the Runtime Gateway in the
  // handlers below so closing is RBAC-checked and audited (CLOSE_JOB action).
  async function closeJob(jobId, operation, payload) {
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    const idFactory = global.AAA_ID_FACTORY;
    const clock = global.AAA_RUNTIME_CLOCK;
    if (!storage || typeof storage.get !== 'function') return;
    let job = storage.get('jobs', jobId);
    job = typeof job?.then === 'function' ? await job : job;
    if (!job) return;
    job.currentState = 'CLOSED';
    job.closedAt = clock && clock.now ? clock.now() : Date.now();
    // Audit log entry for overrides so the reason is visible on the job.
    if (operation === 'OVERRIDE_CLOSURE' && payload && payload.reason) {
      const entry = {
        logId: idFactory ? idFactory.newId() : String(Date.now()),
        timestamp: job.closedAt,
        text: 'Force-closed (override): ' + payload.reason,
        type: 'OVERRIDE'
      };
      job.logs = Array.isArray(job.logs) ? job.logs.concat(entry) : [entry];
    }
    if (typeof storage.put === 'function') await storage.put('jobs', jobId, job);
    if (typeof storage.queueMutation === 'function') {
      await storage.queueMutation({
        mutationId: idFactory ? idFactory.createId('mut') : String(Date.now()),
        entityId: jobId, entityType: 'job', operation: operation, payload: payload,
        timestamp: clock && clock.nowISO ? clock.nowISO() : new Date().toISOString(),
        syncStatus: 'PENDING'
      });
    }
    if (global.AAA_REVIEW_REQUEST_ENGINE && typeof global.AAA_REVIEW_REQUEST_ENGINE.requestReview === 'function') {
      try { global.AAA_REVIEW_REQUEST_ENGINE.requestReview(jobId); } catch (e) { console.warn('review engine error', e); }
    }
    // Outcome capture for the learning loop: a completed close is a 'won' job.
    // The Supervisor scores any agent decisions tied to this job against it.
    try {
      if (global.AAA_DATA && global.AAA_DATA.recordOutcome) {
        const outcome = await global.AAA_DATA.recordOutcome(jobId, 'won', {
          source: operation === 'OVERRIDE_CLOSURE' ? 'force_close' : 'safe_close',
          override: operation === 'OVERRIDE_CLOSURE'
        });
        if (global.AAA_SUPERVISOR && global.AAA_SUPERVISOR.scoreOutcome) {
          await global.AAA_SUPERVISOR.scoreOutcome(outcome);
        }
      }
    } catch (e) { console.warn('Closure HUD: outcome capture skipped', e); }
    if (global.AAA_EVENTS) global.AAA_EVENTS.emit('job.closed', { jobId: jobId });
  }

  // Route a close through the Runtime Gateway: CLOSE_JOB is RBAC-checked
  // (crew can't), audited, and only then runs the mutation. Returns ok.
  async function gatedClose(jobId, operation, payload) {
    const gw = global.AAA_RUNTIME_GATEWAY;
    if (!gw) { await closeJob(jobId, operation, payload); return { ok: true }; }
    return gw.run({
      action: 'CLOSE_JOB', origin: 'human',
      target: { type: 'job', id: jobId },
      detail: { operation: operation, override: operation === 'OVERRIDE_CLOSURE', reason: payload && payload.reason },
      mutate: async () => closeJob(jobId, operation, payload)
    });
  }

  async function handleSafeClose() {
    const jobId = state.jobId;
    if (!jobId) return hideOverlay();
    const res = await gatedClose(jobId, 'CLOSE_JOB', { override: false, manualChecklist: { ...state.manualChecks } });
    if (!res || res.ok === false) {
      const U = ui();
      cardEl.appendChild(U.el('p', { className: 'closure-missing', text: res && res.error === 'FORBIDDEN' ? 'Your role cannot close jobs.' : 'Close failed: ' + ((res && res.error) || 'unknown') }));
      return;
    }
    hideOverlay();
  }

  async function handleForceClose() {
    const jobId = state.jobId;
    if (!jobId) return hideOverlay();
    const missingPoints = CLOSURE_ITEMS.filter((m) => !state.manualChecks[m.key]).map((m) => m.label);
    const message = missingPoints.length
      ? 'You are closing with points incomplete —\n' + missingPoints.join('\n') + '\n\nThis override will be logged and audited.'
      : 'Force close this job? This override will be logged.';

    const result = await ui().confirm({
      title: 'Override & Force Close?',
      message: message,
      confirmLabel: 'Force Close',
      danger: true,
      requireReason: true,
      reasonLabel: 'Reason for override (required)',
      reasonPlaceholder: 'e.g. customer waived before/after photos'
    });
    if (!result) return; // cancelled — keep checklist open

    const res = await gatedClose(jobId, 'OVERRIDE_CLOSURE', {
      missingPoints: missingPoints,
      manualChecklist: { ...state.manualChecks },
      reason: result.reason
    });
    if (!res || res.ok === false) {
      const U = ui();
      cardEl.appendChild(U.el('p', { className: 'closure-missing', text: res && res.error === 'FORBIDDEN' ? 'Your role cannot close jobs.' : 'Close failed: ' + ((res && res.error) || 'unknown') }));
      return;
    }
    hideOverlay();
  }

  async function boot(opts) {
    const jobId = opts && opts.jobId;
    if (!jobId) return;
    state.jobId = jobId;
    state.manualChecks = blankChecks();
    try {
      if (global.AAA_SIDEKICK_CLOSURE && typeof global.AAA_SIDEKICK_CLOSURE.auditJobFile === 'function') {
        state.report = await global.AAA_SIDEKICK_CLOSURE.auditJobFile(jobId);
      } else {
        state.report = { ok: false, ready: false, autoVerified: {}, missingAuto: ['AUDIT_UNAVAILABLE'] };
      }
    } catch (e) {
      state.report = { ok: false, ready: false, autoVerified: {}, missingAuto: ['AUDIT_ERROR'] };
    }
    render();
  }

  global.AAA_CLOSURE_HUD_UI = { boot: boot, hide: hideOverlay };
})(typeof window !== 'undefined' ? window : this);
