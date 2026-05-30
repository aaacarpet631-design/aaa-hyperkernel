/*
 * Voice HUD UI for AAA On‑Site Sidekick
 *
 * This module manages the user interface for hands‑free job logging. It
 * provides a contextually bootable HUD that controls the floating action
 * button and overlay for voice input. The HUD maintains its own state,
 * including the current job ID, and never relies on global variables. It
 * gracefully falls back to a text input mode when speech recognition is
 * unsupported or fails (e.g., due to network issues). The UI integrates
 * with the voice engine to save logs to local storage and queue mutations.
 */

;(function (global) {
  'use strict';

  function createVoiceHUD() {
    const state = {
      currentJobId: null,
      initialized: false,
      hideTimeout: null
    };
    const els = {};

    function initDOM() {
      // Locate required DOM elements by ID
      els.fab = document.getElementById('voice-fab');
      els.overlay = document.getElementById('voice-overlay');
      els.status = document.getElementById('voice-status');
      els.transcript = document.getElementById('voice-transcript');
      if (!els.fab || !els.overlay || !els.status || !els.transcript) {
        console.error('Voice HUD: required DOM elements not found');
        return;
      }
      // Event listener for the FAB
      els.fab.addEventListener('click', handleClick);
    }

    async function handleClick() {
      // Ensure we have a job id in context
      if (!state.currentJobId) {
        showOverlay('No active job', '', false);
        hideOverlay(3000);
        return;
      }
      const voiceAPI = global.AAA_SIDEKICK_VOICE;
      if (!voiceAPI || typeof voiceAPI.startListening !== 'function') {
        showOverlay('Voice engine unavailable', '', false);
        hideOverlay(3000);
        return;
      }
      // Start listening and update UI
      showOverlay('Listening…', '', true);
      const result = await voiceAPI.startListening(state.currentJobId);
      els.fab.classList.remove('listening');
      if (result && result.ok) {
        showOverlay('Saved', result.text, false);
        hideOverlay(3000);
      } else {
        // Show fallback input mode for unsupported or failed speech recognition
        showFallback();
      }
    }

    function showOverlay(status, text, listening) {
      // Clear any pending hide
      if (state.hideTimeout) {
        clearTimeout(state.hideTimeout);
        state.hideTimeout = null;
      }
      els.status.textContent = status || '';
      els.transcript.textContent = text || '';
      els.overlay.classList.add('visible');
      // Remove any existing fallback UI
      if (els.fallback) {
        els.fallback.remove();
        els.fallback = null;
      }
      if (listening) {
        els.fab.classList.add('listening');
      } else {
        els.fab.classList.remove('listening');
      }
    }

    function hideOverlay(delay = 0) {
      if (state.hideTimeout) {
        clearTimeout(state.hideTimeout);
        state.hideTimeout = null;
      }
      state.hideTimeout = setTimeout(() => {
        els.overlay.classList.remove('visible');
        els.fab.classList.remove('listening');
        els.status.textContent = '';
        els.transcript.textContent = '';
        if (els.fallback) {
          els.fallback.remove();
          els.fallback = null;
        }
      }, delay);
    }

    function showFallback() {
      // Remove listening state
      els.fab.classList.remove('listening');
      // Set status prompt
      els.status.textContent = 'No signal. Enter note:';
      els.transcript.textContent = '';
      // Create fallback UI if it does not exist
      if (!els.fallback) {
        els.fallback = document.createElement('div');
        els.fallback.className = 'voice-fallback';
        const textarea = document.createElement('textarea');
        textarea.placeholder = 'Type your note here…';
        const saveButton = document.createElement('button');
        saveButton.className = 'save-button';
        saveButton.textContent = 'Save Note';
        els.fallback.appendChild(textarea);
        els.fallback.appendChild(saveButton);
        els.overlay.appendChild(els.fallback);
        // Save button handler
        saveButton.addEventListener('click', async () => {
          const note = textarea.value.trim();
          if (!note) {
            els.status.textContent = 'Note cannot be empty';
            return;
          }
          const voiceAPI = global.AAA_SIDEKICK_VOICE;
          if (voiceAPI && typeof voiceAPI.saveTextLog === 'function') {
            const saveResult = await voiceAPI.saveTextLog(state.currentJobId, note);
            if (saveResult.ok) {
              els.status.textContent = 'Saved';
              els.transcript.textContent = note;
              // Remove fallback UI and hide overlay after delay
              if (els.fallback) {
                els.fallback.remove();
                els.fallback = null;
              }
              hideOverlay(3000);
            } else {
              els.status.textContent = saveResult.error || 'Error saving note';
            }
          } else {
            els.status.textContent = 'Voice engine unavailable';
          }
        });
      }
      els.overlay.classList.add('visible');
    }

    return {
      /**
       * Boot the voice HUD for a specific job context. This method must be
       * called once per job activation to set the jobId in the HUD. It will
       * initialise DOM bindings on first call.
       *
       * @param {Object} config - configuration object
       * @param {string} config.jobId - The active job's ID
       */
      boot({ jobId }) {
        state.currentJobId = jobId;
        if (!state.initialized) {
          initDOM();
          state.initialized = true;
        }
      },
      /**
       * Update the current job ID. Use this when the active job changes without
       * reinitialising the HUD.
       * @param {string} jobId
       */
      updateJobId(jobId) {
        state.currentJobId = jobId;
      }
    };
  }

  // Attach the HUD UI factory to the global namespace
  global.AAA_VOICE_HUD_UI = createVoiceHUD();
})(typeof window !== 'undefined' ? window : this);