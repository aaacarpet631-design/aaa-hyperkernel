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

  const MANUAL_ITEMS = [
    { key: 'payment', label: 'Payment received / invoice logged' },
    { key: 'tools', label: 'Tools accounted for' },
    { key: 'cleanup', label: 'Site cleaned' },
    { key: 'signoff', label: 'Customer sign-off' },
    { key: 'documents', label: 'Required documents completed' }
  ];

  const state = {
    jobId: null,
    report: null,
    manualChecks: { payment: false, tools: false, cleanup: false, signoff: false, documents: false }
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

  function autoItems() {
    const auto = (state.report && state.report.autoVerified) || {};
    return [
      { key: 'photos', label: 'Before & after photos', ok: !!auto.photos },
      { key: 'estimate', label: 'Estimate / price applied', ok: !!auto.estimate },
      { key: 'notes', label: 'Work notes logged', ok: !!auto.notes },
      { key: 'sync', label: 'All data synced', ok: !!auto.sync }
    ];
  }

  function render() {
    ensureOverlay();
    const U = ui();
    const autos = autoItems();
    const autoOk = autos.filter((a) => a.ok).length;
    const manualOk = Object.values(state.manualChecks).filter(Boolean).length;
    const total = autos.length + MANUAL_ITEMS.length;
    const completed = autoOk + manualOk;
    const readyForSafeClose = autoOk === autos.length && manualOk === MANUAL_ITEMS.length;
    const missing = Array.isArray(state.report && state.report.missingAuto) ? state.report.missingAuto : [];

    cardEl.innerHTML = '';

    // grab handle + header
    cardEl.appendChild(U.el('div', { className: 'closure-grip' }));
    cardEl.appendChild(U.el('h1', { className: 'closure-title', text: 'Departure Checklist' }));
    cardEl.appendChild(U.el('p', { className: 'closure-sub', text: 'Confirm everything before you leave the site.' }));

    // progress
    const bar = U.progressBar(completed, total);
    cardEl.appendChild(U.el('div', { className: 'closure-progress' }, [
      U.el('div', { className: 'closure-progress__row' }, [
        U.el('span', { text: 'Closeout readiness' }),
        U.el('span', { className: 'closure-progress__count', text: completed + '/' + total + ' complete' })
      ]),
      bar.root
    ]));

    // auto verification
    const autoRows = U.el('div', { className: 'closure-rows' });
    autos.forEach((a) => {
      autoRows.appendChild(U.el('div', { className: 'closure-row' + (a.ok ? ' is-ok' : ' is-missing') }, [
        U.el('span', { className: 'closure-row__icon', attrs: { 'aria-hidden': 'true' }, text: a.ok ? '✓' : '!' }),
        U.el('span', { className: 'closure-row__label', text: a.label }),
        U.el('span', { className: 'closure-row__state', text: a.ok ? 'Verified' : 'Missing' })
      ]));
    });
    cardEl.appendChild(section('Auto Verification', autoRows));

    // manual verification (tappable rows)
    const manualRows = U.el('div', { className: 'closure-rows' });
    MANUAL_ITEMS.forEach((m) => {
      const checked = !!state.manualChecks[m.key];
      const row = U.el('button', {
        className: 'closure-check' + (checked ? ' is-checked' : ''),
        attrs: { type: 'button', 'aria-pressed': checked ? 'true' : 'false' },
        on: { click: () => { state.manualChecks[m.key] = !state.manualChecks[m.key]; render(); } }
      }, [
        U.el('span', { className: 'closure-check__box', attrs: { 'aria-hidden': 'true' }, text: checked ? '✓' : '' }),
        U.el('span', { className: 'closure-check__label', text: m.label })
      ]);
      manualRows.appendChild(row);
    });
    cardEl.appendChild(section('Manual Verification', manualRows));

    // missing summary
    if (missing.length) {
      cardEl.appendChild(U.el('p', { className: 'closure-missing', text: 'Auto-blocked: ' + missing.join(', ') }));
    }

    // actions
    const actions = U.el('div', { className: 'closure-actions' });
    actions.appendChild(U.button({
      label: 'Safe Close & Generate Review Request', variant: 'primary', full: true,
      disabled: !readyForSafeClose, onClick: handleSafeClose,
      ariaLabel: readyForSafeClose ? 'Safe close job' : 'Safe close disabled until all items complete'
    }));
    actions.appendChild(U.button({ label: 'Force Close (Override)', variant: 'danger', full: true, onClick: handleForceClose }));
    actions.appendChild(U.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: hideOverlay }));
    cardEl.appendChild(actions);

    if (!readyForSafeClose) {
      cardEl.appendChild(U.el('p', { className: 'closure-hint', text: 'Safe Close unlocks when every item is checked.' }));
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
    Object.keys(state.manualChecks).forEach((k) => { state.manualChecks[k] = false; });
    state.report = null;
    state.jobId = null;
  }

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

  async function handleSafeClose() {
    const jobId = state.jobId;
    if (!jobId) return hideOverlay();
    try {
      await closeJob(jobId, 'CLOSE_JOB', { override: false, manualChecklist: { ...state.manualChecks } });
    } catch (e) { console.error('Closure HUD: safe close error', e); }
    finally { hideOverlay(); }
  }

  async function handleForceClose() {
    const jobId = state.jobId;
    if (!jobId) return hideOverlay();
    const missing = Array.isArray(state.report && state.report.missingAuto) ? state.report.missingAuto : [];
    const missingManual = MANUAL_ITEMS.filter((m) => !state.manualChecks[m.key]).map((m) => m.label);
    const gaps = [];
    if (missing.length) gaps.push('Auto: ' + missing.join(', '));
    if (missingManual.length) gaps.push('Manual: ' + missingManual.join(', '));
    const message = gaps.length
      ? 'You are closing this job with items incomplete —\n' + gaps.join('\n') + '\n\nThis override will be logged.'
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

    try {
      await closeJob(jobId, 'OVERRIDE_CLOSURE', {
        missingAuto: missing,
        missingManual: missingManual,
        manualChecklist: { ...state.manualChecks },
        reason: result.reason
      });
    } catch (e) { console.error('Closure HUD: force close error', e); }
    finally { hideOverlay(); }
  }

  async function boot(opts) {
    const jobId = opts && opts.jobId;
    if (!jobId) return;
    state.jobId = jobId;
    Object.keys(state.manualChecks).forEach((k) => { state.manualChecks[k] = false; });
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
