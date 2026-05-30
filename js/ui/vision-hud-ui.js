/*
 * Vision HUD UI — capture/upload a photo and review an AI repair estimate.
 *
 * Full-width mobile sheet with: a chooser (Capture or Upload / Take Photo /
 * Upload from Gallery), a loading state during analysis, and a result card
 * (service type, severity, confidence, quote range, recommended next step)
 * that always requires human review before applying. Estimates are never
 * applied automatically. Falls back to manual entry when offline.
 */
;(function (global) {
  'use strict';

  const SEVERITY_COLOR = { LOW: '#10B981', MEDIUM: '#F59E0B', HIGH: '#EF4444' };

  function createVisionHUD() {
    const state = { jobId: null, initialized: false };
    const els = {};

    function injectStyles() {
      if (document.getElementById('vision-hud-styles')) return;
      const style = document.createElement('style');
      style.id = 'vision-hud-styles';
      style.textContent = `
        #vision-hud { position: fixed; inset: 0; z-index: 10042; display: none; align-items: flex-end; justify-content: center; background: rgba(0,0,0,0.62); backdrop-filter: blur(5px); }
        #vision-hud.visible { display: flex; }
        #vision-hud .vision-card { width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; background: var(--surface,#141418); border: 1px solid var(--border,#2A2A33); border-radius: 22px 22px 0 0; padding: 0.5rem 1.1rem calc(1.2rem + env(safe-area-inset-bottom,0px)); color: var(--text,#F8FAFC); box-shadow: 0 -14px 50px rgba(0,0,0,0.6); }
        @media (min-width: 600px) { #vision-hud { align-items: center; } #vision-hud .vision-card { border-radius: 22px; } }
        #vision-hud .vision-grip { width: 38px; height: 4px; border-radius: 2px; background: var(--border,#2A2A33); margin: 0.35rem auto 0.7rem; }
        #vision-hud .vision-title { margin: 0; font-size: 1.35rem; font-weight: 800; }
        #vision-hud .vision-help { margin: 0.3rem 0 1rem; color: var(--muted,#A1A1AA); font-size: 0.9rem; line-height: 1.45; }
        #vision-hud .vision-actions { display: flex; flex-direction: column; gap: 0.6rem; }
        #vision-hud .vision-input { display: none; }
        #vision-hud .vision-result { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
        #vision-hud .vision-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; background: var(--surface-2,#1C1C22); border: 1px solid var(--border,#2A2A33); border-radius: 12px; padding: 0.7rem 0.85rem; }
        #vision-hud .vision-row__k { color: var(--muted,#A1A1AA); font-size: 0.85rem; }
        #vision-hud .vision-row__v { font-weight: 700; font-size: 0.95rem; text-align: right; }
        #vision-hud .vision-summary { margin: 0.25rem 0 0; color: var(--text,#F8FAFC); font-size: 0.95rem; line-height: 1.45; }
        #vision-hud .vision-notice { display: flex; gap: 0.5rem; align-items: flex-start; margin: 1rem 0; padding: 0.7rem 0.8rem; font-size: 0.85rem; color: var(--warning,#F59E0B); background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.25); border-radius: 10px; }
        #vision-hud .vision-status { margin: 0.75rem 0; text-align: center; color: var(--muted,#A1A1AA); font-size: 0.95rem; }
        #vision-hud .manual-form { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
      `;
      document.head.appendChild(style);
    }

    function buildHUD() {
      injectStyles();
      const hud = document.createElement('div');
      hud.id = 'vision-hud';
      const card = document.createElement('div');
      card.className = 'vision-card';
      hud.appendChild(card);
      document.body.appendChild(hud);
      els.hud = hud;
      els.card = card;
    }

    function U() { return global.AAA_UI; }

    function clear() { els.card.innerHTML = ''; }

    function headerEls() {
      const frag = document.createDocumentFragment();
      frag.appendChild(U().el('div', { className: 'vision-grip' }));
      frag.appendChild(U().el('h2', { className: 'vision-title', text: 'Vision Estimate' }));
      return frag;
    }

    /** Initial chooser screen. */
    function showChooser() {
      clear();
      els.card.appendChild(headerEls());
      els.card.appendChild(U().el('p', { className: 'vision-help', text: 'Upload a room or damage photo. AI will estimate the service type, severity, and a rough quote range. You review before anything is sent to the customer.' }));

      // hidden inputs
      const camera = U().el('input', { className: 'vision-input', attrs: { type: 'file', accept: 'image/*', capture: 'environment' } });
      const gallery = U().el('input', { className: 'vision-input', attrs: { type: 'file', accept: 'image/*' } });
      camera.addEventListener('change', (e) => onFile(e));
      gallery.addEventListener('change', (e) => onFile(e));

      const actions = U().el('div', { className: 'vision-actions' }, [
        U().button({ label: 'Capture or Upload Photo', icon: '📷', variant: 'primary', full: true, onClick: () => gallery.click() }),
        U().button({ label: 'Take Photo', variant: 'secondary', full: true, onClick: () => camera.click() }),
        U().button({ label: 'Upload from Gallery', variant: 'secondary', full: true, onClick: () => gallery.click() }),
        U().button({ label: 'Cancel', variant: 'ghost', full: true, onClick: hideHUD })
      ]);
      els.card.appendChild(actions);
      els.card.appendChild(camera);
      els.card.appendChild(gallery);
    }

    async function onFile(evt) {
      const files = evt.target.files;
      if (!files || !files.length) return;
      const file = files[0];
      evt.target.value = '';
      showLoading();
      const vision = global.AAA_SIDEKICK_VISION;
      if (!vision || typeof vision.captureAndAnalyze !== 'function') {
        showError('Vision engine unavailable.');
        return;
      }
      const result = await vision.captureAndAnalyze(state.jobId, file);
      if (result && result.ok) {
        showResult(result.analysis);
      } else if (result && result.status === 'QUEUED_FOR_NETWORK') {
        showManualInput('Saved offline — AI analysis will run when you’re back online. Enter an estimate now if you like.');
      } else {
        showError((result && result.error) || 'Analysis failed. Please try again.');
      }
    }

    function showLoading() {
      clear();
      els.card.appendChild(headerEls());
      els.card.appendChild(U().spinner('Analyzing photo…'));
    }

    function showError(msg) {
      clear();
      els.card.appendChild(headerEls());
      els.card.appendChild(U().el('p', { className: 'vision-status', text: msg }));
      els.card.appendChild(U().el('div', { className: 'vision-actions' }, [
        U().button({ label: 'Try Again', variant: 'primary', full: true, onClick: showChooser }),
        U().button({ label: 'Close', variant: 'ghost', full: true, onClick: hideHUD })
      ]));
    }

    function row(k, v) {
      return U().el('div', { className: 'vision-row' }, [
        U().el('span', { className: 'vision-row__k', text: k }),
        typeof v === 'string'
          ? U().el('span', { className: 'vision-row__v', text: v })
          : U().el('span', { className: 'vision-row__v' }, [v])
      ]);
    }

    function showResult(analysis) {
      clear();
      els.card.appendChild(headerEls());
      if (!analysis || typeof analysis !== 'object') return showError('No analysis returned.');

      const sev = String(analysis.severity || '').toUpperCase();
      const result = U().el('div', { className: 'vision-result' });
      result.appendChild(row('Service type', analysis.type || '—'));
      if (sev) result.appendChild(row('Severity', U().statusBadge(sev, SEVERITY_COLOR[sev] || '#A1A1AA')));
      if (analysis.confidence != null && analysis.confidence !== '') result.appendChild(row('Confidence', Math.round(Number(analysis.confidence)) + '%'));
      if (analysis.estimatedQuoteRange) result.appendChild(row('Quote range', String(analysis.estimatedQuoteRange)));
      if (analysis.estimatedTimeMins) result.appendChild(row('Est. labor', analysis.estimatedTimeMins + ' mins'));
      if (Array.isArray(analysis.materials) && analysis.materials.length) result.appendChild(row('Materials', analysis.materials.join(', ')));
      if (analysis.recommendedNextStep) result.appendChild(row('Next step', String(analysis.recommendedNextStep)));
      els.card.appendChild(result);

      if (analysis.summary) els.card.appendChild(U().el('p', { className: 'vision-summary', text: analysis.summary }));

      els.card.appendChild(U().el('div', { className: 'vision-notice' }, [
        U().el('span', { attrs: { 'aria-hidden': 'true' }, text: '⚠️' }),
        U().el('span', { text: 'Human review required — confirm before sending this quote to the customer.' })
      ]));

      els.card.appendChild(U().el('div', { className: 'vision-actions' }, [
        U().button({ label: 'Approve & Apply', icon: '✓', variant: 'primary', full: true, onClick: async () => {
          await applyEstimate(analysis);
          showSaved('Estimate applied to job.');
        } }),
        U().button({ label: 'Discard', variant: 'ghost', full: true, onClick: showChooser })
      ]));
    }

    function showSaved(msg) {
      clear();
      els.card.appendChild(headerEls());
      els.card.appendChild(U().el('p', { className: 'vision-status', text: '✓ ' + msg }));
      setTimeout(hideHUD, 1400);
    }

    function showManualInput(note) {
      clear();
      els.card.appendChild(headerEls());
      if (note) els.card.appendChild(U().el('p', { className: 'vision-help', text: note }));
      const typeInput = U().el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Service type (e.g. Seam repair)' } });
      const timeInput = U().el('input', { className: 'aaa-input', attrs: { type: 'number', placeholder: 'Estimated time (mins)' } });
      const materialsInput = U().el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Materials (comma separated)' } });
      const quoteInput = U().el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Quote range (optional, e.g. $150–$300)' } });
      const status = U().el('p', { className: 'vision-status', text: '' });
      els.card.appendChild(U().el('div', { className: 'manual-form' }, [typeInput, timeInput, materialsInput, quoteInput]));
      els.card.appendChild(status);
      els.card.appendChild(U().el('div', { className: 'vision-actions' }, [
        U().button({ label: 'Save Estimate', variant: 'primary', full: true, onClick: async () => {
          const type = typeInput.value.trim();
          const time = parseInt(timeInput.value, 10);
          if (!type || isNaN(time)) { status.textContent = 'Please enter a service type and time.'; return; }
          const materials = materialsInput.value.trim() ? materialsInput.value.split(',').map((m) => m.trim()).filter(Boolean) : [];
          await applyEstimate({ type: type, estimatedTimeMins: time, materials: materials, estimatedQuoteRange: quoteInput.value.trim() || null, source: 'MANUAL' });
          showSaved('Estimate saved.');
        } }),
        U().button({ label: 'Cancel', variant: 'ghost', full: true, onClick: hideHUD })
      ]));
    }

    async function applyEstimate(estimate) {
      if (!state.jobId || !estimate) return;
      const storage = global.AAA_LOCAL_FIRST_STORAGE;
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      try {
        let job = storage.get('jobs', state.jobId);
        job = typeof job?.then === 'function' ? await job : job;
        if (!job || typeof job !== 'object') return;
        const estimateId = idFactory && idFactory.newId ? idFactory.newId() : Date.now().toString();
        const estimateEntry = Object.assign({ estimateId: estimateId }, estimate);
        const updatedJob = Object.assign({}, job, {
          estimates: Array.isArray(job.estimates) ? job.estimates.concat(estimateEntry) : [estimateEntry]
        });
        if (typeof storage.put === 'function') await storage.put('jobs', state.jobId, updatedJob);
        if (typeof storage.queueMutation === 'function') {
          storage.queueMutation({
            mutationId: idFactory ? idFactory.createId('mut') : String(Date.now()),
            entityId: state.jobId, entityType: 'job', operation: 'ADD_ESTIMATE', payload: estimateEntry,
            timestamp: clock && clock.nowISO ? clock.nowISO() : new Date().toISOString(), syncStatus: 'PENDING'
          });
        }
        if (global.AAA_EVENTS) global.AAA_EVENTS.emit('estimate.added', { jobId: state.jobId });
      } catch (err) { console.error('Vision HUD: failed to apply estimate', err); }
    }

    function hideHUD() { if (els.hud) els.hud.classList.remove('visible'); }

    return {
      boot({ jobId }) {
        state.jobId = jobId;
        if (!state.initialized) { buildHUD(); state.initialized = true; }
        showChooser();
        if (els.hud) els.hud.classList.add('visible');
      },
      hide() { hideHUD(); }
    };
  }

  global.AAA_VISION_HUD_UI = createVisionHUD();
})(typeof window !== 'undefined' ? window : this);
