/*
 * Vision HUD UI for AAA On‑Site Sidekick
 *
 * This module manages the user interface for capturing photos and
 * presenting AI-generated draft estimates. It provides a bootable HUD
 * that attaches to the DOM and stays hidden until activated. The HUD
 * supports both immediate analysis (when online) and offline fallback
 * manual entry. Estimates are not applied automatically; the user must
 * approve them via the UI.
 */

;(function (global) {
  'use strict';

  function createVisionHUD() {
    const state = {
      jobId: null,
      initialized: false
    };
    const els = {};

    /**
     * Inject minimal CSS to support the HUD. This is done only once.
     */
    function injectStyles() {
      if (document.getElementById('vision-hud-styles')) return;
      const style = document.createElement('style');
      style.id = 'vision-hud-styles';
      style.textContent = `
        /* Vision HUD container */
        #vision-hud { position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: none; justify-content: center; align-items: center; z-index: 10002; backdrop-filter: blur(6px); background: rgba(20,20,25,0.85); }
        #vision-hud.visible { display: flex; }
        #vision-hud .vision-card { background: rgba(30,30,35,0.9); border-radius: 20px; padding: 1.5rem; max-width: 90%; color: #ffffff; box-shadow: 0 4px 32px rgba(0,0,0,0.4); }
        #vision-hud h2 { margin-top: 0; margin-bottom: 1rem; font-size: 1.75rem; }
        #vision-hud .vision-actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: flex-end; }
        #vision-hud .vision-actions button { padding: 0.75rem 1.25rem; font-size: 1rem; font-weight: 600; border-radius: 12px; border: none; cursor: pointer; }
        #vision-hud .primary { background-color: #00FF9D; color: #141419; }
        #vision-hud .secondary { background: transparent; color: #00FF9D; border: 2px solid #00FF9D; }
        #vision-hud .status-badge { margin-top: 1rem; color: #00FF9D; font-size: 1rem; }
        /* File input hidden */
        #vision-file-input { display: none; }
        /* Manual input form */
        #vision-hud .manual-form { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
        #vision-hud .manual-form input, #vision-hud .manual-form textarea { padding: 0.5rem; border-radius: 8px; border: 1px solid #00FF9D; background: rgba(40,40,45,0.7); color: #ffffff; font-size: 1rem; }
        #vision-hud .manual-form button { padding: 0.75rem; font-size: 1rem; font-weight: 600; border-radius: 8px; cursor: pointer; }
      `;
      document.head.appendChild(style);
    }

    /**
     * Build the HUD DOM elements and append to the document body.
     */
    function buildHUD() {
      injectStyles();
      // Container
      const hud = document.createElement('div');
      hud.id = 'vision-hud';
      // Card
      const card = document.createElement('div');
      card.className = 'vision-card';
      // Heading and upload button
      const header = document.createElement('h2');
      header.textContent = 'Vision Estimate';
      const uploadBtn = document.createElement('button');
      uploadBtn.className = 'primary';
      uploadBtn.textContent = 'Capture / Upload Photo';
      // Hidden file input
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.id = 'vision-file-input';
      // Status badge
      const statusBadge = document.createElement('div');
      statusBadge.className = 'status-badge';
      statusBadge.textContent = '';
      // Proposal container
      const proposalContainer = document.createElement('div');
      proposalContainer.id = 'vision-proposal';
      // Assemble card
      card.appendChild(header);
      card.appendChild(uploadBtn);
      card.appendChild(fileInput);
      card.appendChild(statusBadge);
      card.appendChild(proposalContainer);
      hud.appendChild(card);
      document.body.appendChild(hud);
      // Save references
      els.hud = hud;
      els.uploadBtn = uploadBtn;
      els.fileInput = fileInput;
      els.statusBadge = statusBadge;
      els.proposalContainer = proposalContainer;
      // Event listeners
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFileSelect);
    }

    /**
     * Handle file selection and start analysis.
     * @param {Event} evt
     */
    async function handleFileSelect(evt) {
      const files = evt.target.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      // Clear previous proposal and status
      els.proposalContainer.innerHTML = '';
      els.statusBadge.textContent = '';
      // Show loading
      els.statusBadge.textContent = 'Analyzing…';
      const vision = global.AAA_SIDEKICK_VISION;
      if (!vision || typeof vision.captureAndAnalyze !== 'function') {
        els.statusBadge.textContent = 'Vision engine unavailable';
        return;
      }
      const result = await vision.captureAndAnalyze(state.jobId, file);
      if (result.ok) {
        // Online analysis succeeded
        els.statusBadge.textContent = '';
        showDraftProposal(result.analysis);
      } else {
        // Offline: queued for network
        if (result.status === 'QUEUED_FOR_NETWORK') {
          els.statusBadge.textContent = 'Analysis pending network';
          showManualInput();
        } else {
          els.statusBadge.textContent = result.error || 'Analysis failed';
        }
      }
      // Reset file input for next capture
      evt.target.value = '';
    }

    /**
     * Render the draft proposal card with AI analysis and approval controls.
     * @param {Object} analysis - The structured estimate from AI.
     */
    function showDraftProposal(analysis) {
      els.proposalContainer.innerHTML = '';
      if (!analysis || typeof analysis !== 'object') return;
      const card = document.createElement('div');
      card.className = 'proposal-card';
      const summary = document.createElement('div');
      summary.innerHTML = `
        <p><strong>Type:</strong> ${analysis.type || ''}</p>
        <p><strong>Estimated Time:</strong> ${analysis.estimatedTimeMins || ''} mins</p>
        <p><strong>Materials:</strong> ${Array.isArray(analysis.materials) ? analysis.materials.join(', ') : ''}</p>
      `;
      // Actions
      const actions = document.createElement('div');
      actions.className = 'vision-actions';
      const approveBtn = document.createElement('button');
      approveBtn.className = 'primary';
      approveBtn.textContent = 'Approve & Apply';
      const discardBtn = document.createElement('button');
      discardBtn.className = 'secondary';
      discardBtn.textContent = 'Discard';
      actions.appendChild(discardBtn);
      actions.appendChild(approveBtn);
      card.appendChild(summary);
      card.appendChild(actions);
      els.proposalContainer.appendChild(card);
      // Discard handler
      discardBtn.addEventListener('click', () => {
        els.proposalContainer.innerHTML = '';
        els.statusBadge.textContent = '';
      });
      // Approve handler
      approveBtn.addEventListener('click', async () => {
        await applyEstimate(analysis);
        els.proposalContainer.innerHTML = '';
        els.statusBadge.textContent = 'Estimate applied';
        // Hide after 2 seconds
        setTimeout(() => {
          hideHUD();
        }, 2000);
      });
    }

    /**
     * Show manual input form for offline entry. Allows user to enter type,
     * estimated time, and materials, then save to job.
     */
    function showManualInput() {
      els.proposalContainer.innerHTML = '';
      const form = document.createElement('div');
      form.className = 'manual-form';
      const typeInput = document.createElement('input');
      typeInput.type = 'text';
      typeInput.placeholder = 'Type (e.g., SEAM_REPAIR)';
      const timeInput = document.createElement('input');
      timeInput.type = 'number';
      timeInput.placeholder = 'Estimated time (mins)';
      const materialsInput = document.createElement('input');
      materialsInput.type = 'text';
      materialsInput.placeholder = 'Materials (comma separated)';
      const actions = document.createElement('div');
      actions.className = 'vision-actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'primary';
      saveBtn.textContent = 'Save';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary';
      cancelBtn.textContent = 'Cancel';
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      form.appendChild(typeInput);
      form.appendChild(timeInput);
      form.appendChild(materialsInput);
      form.appendChild(actions);
      els.proposalContainer.appendChild(form);
      cancelBtn.addEventListener('click', () => {
        els.proposalContainer.innerHTML = '';
        els.statusBadge.textContent = '';
      });
      saveBtn.addEventListener('click', async () => {
          const type = typeInput.value.trim();
          const time = parseInt(timeInput.value, 10);
          const materialsStr = materialsInput.value.trim();
          if (!type || isNaN(time)) {
            els.statusBadge.textContent = 'Please fill in type and time';
            return;
          }
          const materials = materialsStr ? materialsStr.split(',').map((m) => m.trim()).filter(Boolean) : [];
          const manualEstimate = { type: type, estimatedTimeMins: time, materials: materials };
          await applyEstimate(manualEstimate);
          els.proposalContainer.innerHTML = '';
          els.statusBadge.textContent = 'Estimate saved';
          setTimeout(() => { hideHUD(); }, 2000);
      });
    }

    /**
     * Apply an estimate to the job: update the job record and queue a mutation.
     * @param {Object} estimate - The estimate to apply.
     */
    async function applyEstimate(estimate) {
      if (!state.jobId || !estimate) return;
      const storage = global.AAA_LOCAL_FIRST_STORAGE;
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      try {
        // Retrieve current job
        let job = storage.get('jobs', state.jobId);
        job = typeof job?.then === 'function' ? await job : job;
        if (!job || typeof job !== 'object') return;
        // Create estimate ID
        const estimateId = idFactory && typeof idFactory.newId === 'function' ? idFactory.newId() : Date.now().toString();
        const estimateEntry = Object.assign({ estimateId: estimateId }, estimate);
        // Append estimate to job
        const updatedJob = Object.assign({}, job, {
          estimates: Array.isArray(job.estimates) ? job.estimates.concat(estimateEntry) : [estimateEntry]
        });
        // Persist job locally
        if (typeof storage.put === 'function') {
          await storage.put('jobs', state.jobId, updatedJob);
        }
        // Queue mutation
        if (
          typeof storage.queueMutation === 'function' &&
          idFactory &&
          ((typeof idFactory.createId === 'function') || (typeof idFactory.newId === 'function'))
        ) {
          const mutationId = idFactory && typeof idFactory.createId === 'function' ? idFactory.createId('mut', []) : idFactory.newId();
          const timestampISO = clock && typeof clock.nowISO === 'function' ? clock.nowISO() : new Date().toISOString();
          const mutation = {
            mutationId: mutationId,
            entityId: state.jobId,
            entityType: 'job',
            operation: 'ADD_ESTIMATE',
            payload: estimateEntry,
            timestamp: timestampISO,
            syncStatus: 'PENDING'
          };
          storage.queueMutation(mutation);
        }
      } catch (err) {
        console.error('Vision HUD: failed to apply estimate', err);
      }
    }

    /**
     * Hide the HUD.
     */
    function hideHUD() {
      if (els.hud) {
        els.hud.classList.remove('visible');
        els.statusBadge.textContent = '';
        els.proposalContainer.innerHTML = '';
      }
    }

    return {
      /**
       * Boot the Vision HUD with a job context. Initializes DOM elements on
       * first call.
       * @param {Object} config
       * @param {string} config.jobId
       */
      boot({ jobId }) {
        state.jobId = jobId;
        if (!state.initialized) {
          buildHUD();
          state.initialized = true;
        }
        // Show HUD when booted; the capture action is triggered by user
        if (els.hud) {
          els.hud.classList.add('visible');
        }
      },
      /**
       * Hide the Vision HUD.
       */
      hide() {
        hideHUD();
      }
    };
  }

  global.AAA_VISION_HUD_UI = createVisionHUD();
})(typeof window !== 'undefined' ? window : this);