/*
 * AAA_CLOSURE_HUD_UI
 *
 * Provides a user interface for the Closure Gateway.  When invoked, this
 * module audits the selected job via AAA_SIDEKICK_CLOSURE and presents
 * the nine‑point checklist required to safely close a job.  The UI
 * displays auto‑verified items and allows the user to confirm the
 * remaining manual items via large toggle switches.  Only when all
 * requirements are satisfied does the "Safe Close" action become
 * available.  A "Force Close" option is provided to override warnings
 * and log an override mutation.
 */

;(function (global) {
  'use strict';

  // Internal state for the closure HUD
  const state = {
    jobId: null,
    report: null,
    manualChecks: {
      payment: false,
      tools: false,
      cleanup: false,
      signoff: false,
      documents: false
    }
  };

  let overlayEl = null;
  let cardEl = null;

  /**
   * Ensure the overlay exists in the DOM. Creates and attaches it on first use.
   */
  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    // Create overlay container
    overlayEl = document.createElement('div');
    overlayEl.id = 'closure-hud';
    overlayEl.className = 'closure-hud hidden';
    // Create card element
    cardEl = document.createElement('div');
    cardEl.className = 'closure-card';
    overlayEl.appendChild(cardEl);
    // Append overlay to body
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  /**
   * Render the Closure HUD UI based on current state.
   */
  function render() {
    ensureOverlay();
    // Build HTML content for card
    const r = state.report;
    const auto = (r && r.autoVerified) || {};
    const missing = Array.isArray(r && r.missingAuto) ? r.missingAuto : [];
    const allAutoOk = auto.photos && auto.estimate && auto.notes && auto.sync;
    // Determine if manual checks are all true
    const manualOk = Object.values(state.manualChecks).every((v) => v);
    const readyForSafeClose = allAutoOk && manualOk;
    // Build lists for auto items
    const autoItems = [
      { key: 'photos', label: 'Before & After Photos', ok: !!auto.photos },
      { key: 'estimate', label: 'Estimate/Price', ok: !!auto.estimate },
      { key: 'notes', label: 'Work Notes Logged', ok: !!auto.notes },
      { key: 'sync', label: 'All Data Synced', ok: !!auto.sync }
    ];
    // Manual items definitions
    const manualItems = [
      { key: 'payment', label: 'Payment Received/Invoice Logged' },
      { key: 'tools', label: 'Tools Accounted For' },
      { key: 'cleanup', label: 'Site Cleaned' },
      { key: 'signoff', label: 'Customer Sign‑Off' },
      { key: 'documents', label: 'Required Documents Completed' }
    ];
    // Determine color pulse class
    let statusClass = 'status-error';
    if (readyForSafeClose) {
      statusClass = 'status-success';
    } else if (allAutoOk) {
      statusClass = 'status-warning';
    }
    // Build HTML
    const autoListHTML = autoItems
      .map((item) => {
        const cls = item.ok ? 'item-ok' : 'item-missing';
        return `<li class="${cls}"><span>${item.label}</span></li>`;
      })
      .join('');
    const manualListHTML = manualItems
      .map((item) => {
        const checked = state.manualChecks[item.key] ? 'checked' : '';
        return `<li><label><input type="checkbox" data-key="${item.key}" ${checked}> ${item.label}</label></li>`;
      })
      .join('');
    // Buttons
    const safeDisabled = readyForSafeClose ? '' : 'disabled';
    const overrideLabel = missing.length > 0 ? `Force Close (Override ${missing.join(', ')})` : 'Force Close';
    cardEl.innerHTML = `
      <h1 class="closure-title">Departure Checklist</h1>
      <div class="auto-section">
        <h2>Auto Verified</h2>
        <ul class="auto-list">${autoListHTML}</ul>
        ${missing.length > 0 ? `<p class="missing-msg">Missing: ${missing.join(', ')}</p>` : ''}
      </div>
      <div class="manual-section">
        <h2>Manual Verification</h2>
        <ul class="manual-list">${manualListHTML}</ul>
      </div>
      <div class="action-buttons ${statusClass}">
        <button id="closure-safe-btn" class="closure-btn primary" ${safeDisabled}>Safe Close &amp; Generate Review Request</button>
        <button id="closure-force-btn" class="closure-btn secondary">${overrideLabel}</button>
        <button id="closure-cancel-btn" class="closure-btn tertiary">Cancel</button>
      </div>
    `;
    // Show overlay
    overlayEl.classList.remove('hidden');
    // Attach event listeners for checkboxes and buttons
    cardEl.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.addEventListener('change', (evt) => {
        const key = evt.target.getAttribute('data-key');
        if (key) {
          state.manualChecks[key] = evt.target.checked;
          // Re-render to update button state
          render();
        }
      });
    });
    const safeBtn = cardEl.querySelector('#closure-safe-btn');
    const forceBtn = cardEl.querySelector('#closure-force-btn');
    const cancelBtn = cardEl.querySelector('#closure-cancel-btn');
    if (safeBtn) safeBtn.addEventListener('click', handleSafeClose);
    if (forceBtn) forceBtn.addEventListener('click', handleForceClose);
    if (cancelBtn) cancelBtn.addEventListener('click', hideOverlay);
  }

  /**
   * Hide the overlay and reset manual checks.
   */
  function hideOverlay() {
    if (overlayEl) {
      overlayEl.classList.add('hidden');
    }
    // Reset manual checks for next time
    Object.keys(state.manualChecks).forEach((k) => {
      state.manualChecks[k] = false;
    });
    state.report = null;
    state.jobId = null;
  }

  /**
   * Called when the user presses the Safe Close button.  Only enabled when
   * all auto and manual criteria are satisfied.  Updates the job state,
   * queues a mutation, and triggers review request if available.
   */
  async function handleSafeClose() {
    const jobId = state.jobId;
    if (!jobId) {
      hideOverlay();
      return;
    }
    try {
      const storage = global.AAA_LOCAL_FIRST_STORAGE;
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      if (!storage || typeof storage.get !== 'function') {
        console.error('Closure HUD: storage unavailable');
        hideOverlay();
        return;
      }
      // Retrieve the job
      let job = storage.get('jobs', jobId);
      job = typeof job?.then === 'function' ? await job : job;
      if (!job) {
        console.error('Closure HUD: job not found for safe close');
        hideOverlay();
        return;
      }
      // Update job state to CLOSED
      job.currentState = 'CLOSED';
      if (typeof storage.put === 'function') {
        await storage.put('jobs', jobId, job);
      }
      // Prepare mutation record
      const mutationId = idFactory && typeof idFactory.createId === 'function'
        ? idFactory.createId('mut', [])
        : (idFactory && typeof idFactory.newId === 'function' ? idFactory.newId() : String(Date.now()));
      const timestamp = clock && typeof clock.nowISO === 'function'
        ? clock.nowISO()
        : new Date().toISOString();
      const mutation = {
        mutationId,
        entityId: jobId,
        entityType: 'job',
        operation: 'CLOSE_JOB',
        payload: {
          override: false,
          manualChecklist: { ...state.manualChecks }
        },
        timestamp,
        syncStatus: 'PENDING'
      };
      if (typeof storage.queueMutation === 'function') {
        await storage.queueMutation(mutation);
      }
      // Trigger review request engine if available
      if (global.AAA_REVIEW_REQUEST_ENGINE && typeof global.AAA_REVIEW_REQUEST_ENGINE.requestReview === 'function') {
        try {
          global.AAA_REVIEW_REQUEST_ENGINE.requestReview(jobId);
        } catch (e) {
          console.warn('Closure HUD: review request engine error', e);
        }
      }
    } catch (e) {
      console.error('Closure HUD: error during safe close', e);
    } finally {
      hideOverlay();
    }
  }

  /**
   * Called when the user presses the Force Close button.  Allows closure even
   * when auto or manual checks are missing.  Logs an OVERRIDE_CLOSURE mutation.
   */
  async function handleForceClose() {
    const jobId = state.jobId;
    if (!jobId) {
      hideOverlay();
      return;
    }
    try {
      const storage = global.AAA_LOCAL_FIRST_STORAGE;
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      if (!storage || typeof storage.get !== 'function') {
        console.error('Closure HUD: storage unavailable for force close');
        hideOverlay();
        return;
      }
      // Retrieve job
      let job = storage.get('jobs', jobId);
      job = typeof job?.then === 'function' ? await job : job;
      if (!job) {
        console.error('Closure HUD: job not found for force close');
        hideOverlay();
        return;
      }
      // Update job state to CLOSED
      job.currentState = 'CLOSED';
      if (typeof storage.put === 'function') {
        await storage.put('jobs', jobId, job);
      }
      // Prepare override mutation
      const mutationId = idFactory && typeof idFactory.createId === 'function'
        ? idFactory.createId('mut', [])
        : (idFactory && typeof idFactory.newId === 'function' ? idFactory.newId() : String(Date.now()));
      const timestamp = clock && typeof clock.nowISO === 'function'
        ? clock.nowISO()
        : new Date().toISOString();
      const missingAuto = (state.report && Array.isArray(state.report.missingAuto)) ? state.report.missingAuto : [];
      const mutation = {
        mutationId,
        entityId: jobId,
        entityType: 'job',
        operation: 'OVERRIDE_CLOSURE',
        payload: {
          missingAuto,
          manualChecklist: { ...state.manualChecks }
        },
        timestamp,
        syncStatus: 'PENDING'
      };
      if (typeof storage.queueMutation === 'function') {
        await storage.queueMutation(mutation);
      }
      // Trigger review request engine if available
      if (global.AAA_REVIEW_REQUEST_ENGINE && typeof global.AAA_REVIEW_REQUEST_ENGINE.requestReview === 'function') {
        try {
          global.AAA_REVIEW_REQUEST_ENGINE.requestReview(jobId);
        } catch (e) {
          console.warn('Closure HUD: review request engine error', e);
        }
      }
    } catch (e) {
      console.error('Closure HUD: error during force close', e);
    } finally {
      hideOverlay();
    }
  }

  /**
   * Public method to initialise the closure HUD for a specific job.  It
   * audits the job file and then renders the UI overlay accordingly.
   * @param {{ jobId: string }} opts
   */
  async function boot(opts) {
    const jobId = opts && opts.jobId;
    if (!jobId) return;
    state.jobId = jobId;
    // Reset manual checks
    Object.keys(state.manualChecks).forEach((k) => {
      state.manualChecks[k] = false;
    });
    // Audit job file
    try {
      if (global.AAA_SIDEKICK_CLOSURE && typeof global.AAA_SIDEKICK_CLOSURE.auditJobFile === 'function') {
        state.report = await global.AAA_SIDEKICK_CLOSURE.auditJobFile(jobId);
      } else {
        state.report = { ok: false, ready: false, autoVerified: {}, missingAuto: ['AUDIT_UNAVAILABLE'] };
      }
    } catch (e) {
      state.report = { ok: false, ready: false, autoVerified: {}, missingAuto: ['AUDIT_ERROR'] };
    }
    // Render the overlay
    render();
  }

  // Export public API
  global.AAA_CLOSURE_HUD_UI = {
    boot,
    hide: hideOverlay
  };
})(typeof window !== 'undefined' ? window : this);