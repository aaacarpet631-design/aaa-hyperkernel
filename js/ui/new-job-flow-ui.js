/*
 * AAA New Job Flow UI
 *
 * Drives creation of a new job: pick/create a customer, set the schedule, then
 * persist the job locally and queue a CREATE_JOB mutation for later sync. The
 * device's coordinates are captured silently at creation time (when permitted)
 * so the Context Engine can later detect arrival on-site.
 *
 * Loaded as a classic script and exposed on window.AAA_NEW_JOB_FLOW_UI.
 */
;(function (global) {
  'use strict';

  /**
   * Build a job record. Always resolves to a valid record even when
   * geolocation is denied or unavailable (lat/lon remain null).
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async function buildJobRecord(data) {
    data = data || {};
    const idFactory = global.AAA_ID_FACTORY;
    const clock = global.AAA_RUNTIME_CLOCK;

    const jobRecord = {
      id: idFactory && idFactory.newId ? idFactory.newId() : String(Date.now()),
      customerId: data.customerId || null,
      customerName: data.customerName || null,
      serviceAddress: data.serviceAddress || null,
      scheduledDate: data.scheduledDate || null,
      gateCode: data.gateCode || null,
      notes: data.notes || '',
      currentState: data.currentState || 'QUOTE_OPEN',
      logs: [],
      estimates: [],
      createdAt: clock && clock.now ? clock.now() : Date.now(),
      latitude: null,
      longitude: null
    };

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const coords = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve(pos.coords),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
          );
        });
        if (coords) {
          jobRecord.latitude = coords.latitude;
          jobRecord.longitude = coords.longitude;
        }
      } catch (_) {
        /* coordinates remain null */
      }
    }

    return jobRecord;
  }

  /** Persist a freshly built job and queue its creation mutation. */
  async function saveJob(job) {
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    if (!storage || typeof storage.put !== 'function') return job;
    await storage.put('jobs', job.id, job);
    if (typeof storage.queueMutation === 'function') {
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      await storage.queueMutation({
        mutationId: idFactory ? idFactory.createId('mut') : String(Date.now()),
        entityId: job.id,
        entityType: 'job',
        operation: 'CREATE_JOB',
        payload: job,
        timestamp: clock ? clock.nowISO() : new Date().toISOString(),
        syncStatus: 'PENDING'
      });
    }
    if (global.AAA_EVENTS) global.AAA_EVENTS.emit('job.created', { jobId: job.id });
    return job;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Run the full new-job flow. Resolves with the created job, or null if the
   * user cancels at any step.
   * @returns {Promise<Object|null>}
   */
  async function open() {
    const picker = global.AAA_CUSTOMER_PICKER_UI;
    const customer = picker && picker.pick ? await picker.pick() : null;
    if (!customer) return null;

    return new Promise((resolve) => {
      const overlay = el('div', 'aaa-modal-overlay');
      const modal = el('div', 'aaa-modal');

      modal.appendChild(el('h2', 'aaa-modal-title', 'New Job'));

      const who = el('div', 'aaa-job-customer');
      who.appendChild(el('span', 'aaa-picker-name', customer.name || 'Customer'));
      if (customer.address) who.appendChild(el('span', 'aaa-picker-sub', customer.address));
      modal.appendChild(who);

      const dateLabel = el('label', 'aaa-field-label', 'Scheduled date & time');
      const dateInput = el('input', 'aaa-input');
      dateInput.type = 'datetime-local';

      const notesLabel = el('label', 'aaa-field-label', 'Notes (optional)');
      const notesInput = el('textarea', 'aaa-input aaa-textarea');
      notesInput.placeholder = 'Access details, scope, etc.';

      const form = el('div', 'aaa-form');
      form.appendChild(dateLabel);
      form.appendChild(dateInput);
      form.appendChild(notesLabel);
      form.appendChild(notesInput);
      modal.appendChild(form);

      function close(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result || null);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
      }

      const cancelBtn = el('button', 'aaa-btn aaa-btn-ghost', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => close(null));

      const createBtn = el('button', 'aaa-btn aaa-btn-primary', 'Create Job');
      createBtn.type = 'button';
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        createBtn.textContent = 'Locating…';
        const job = await buildJobRecord({
          customerId: customer.id,
          customerName: customer.name,
          serviceAddress: customer.address || null,
          gateCode: customer.gateCode || null,
          scheduledDate: dateInput.value || null,
          notes: notesInput.value.trim(),
          currentState: dateInput.value ? 'SCHEDULED' : 'QUOTE_OPEN'
        });
        await saveJob(job);
        close(job);
      });

      const actions = el('div', 'aaa-modal-actions');
      actions.appendChild(cancelBtn);
      actions.appendChild(createBtn);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    });
  }

  global.AAA_NEW_JOB_FLOW_UI = {
    open,
    buildJobRecord,
    saveJob
  };
})(typeof window !== 'undefined' ? window : this);
