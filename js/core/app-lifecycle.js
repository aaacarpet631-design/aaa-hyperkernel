/*
 * HyperKernel App Lifecycle
 *
 * This module wires the Sidekick Context Engine into the application lifecycle so
 * that arrival detection occurs whenever the PWA is brought to the foreground.
 * When the document becomes visible, it retrieves all local jobs, invokes the
 * sidekick context poller, and displays the Arrival HUD if the user is near a
 * scheduled job. All interactions are local-first and avoid any network I/O.
 */

;(function (global) {
  'use strict';

  /**
   * Handle the visibility change event. When the document becomes visible,
   * fetch jobs and detect arrival.
   */
  async function handleVisibilityChange() {
    // Only act when the page has become visible
    if (document.visibilityState !== 'visible') {
      return;
    }
    try {
      const storage = global.AAA_LOCAL_FIRST_STORAGE;
      const context = global.AAA_SIDEKICK_CONTEXT;
      const hud = global.AAA_ARRIVAL_HUD;
      if (!storage || typeof storage.getAll !== 'function') {
        return;
      }
      // Fetch all jobs from local storage. Expect an array of job records.
      let jobs;
      try {
        const result = storage.getAll('jobs');
        jobs = typeof result.then === 'function' ? await result : result;
      } catch (e) {
        console.error('Failed to retrieve jobs', e);
        return;
      }
      if (!context || typeof context.pollArrival !== 'function') {
        return;
      }
      const detectResult = await context.pollArrival(jobs || []);
      if (detectResult && detectResult.ok && detectResult.job) {
        if (hud && typeof hud.showArrivalHud === 'function') {
          hud.showArrivalHud(detectResult.job);
        }
      }
    } catch (err) {
      // Log but do not propagate errors
      console.error('Error during arrival detection', err);
    }
  }

  // Listen for visibility changes
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Trigger immediately if the page is already visible on load
  if (document.visibilityState === 'visible') {
    // We fire this asynchronously to avoid blocking startup
    setTimeout(handleVisibilityChange, 0);
  }
})(typeof window !== 'undefined' ? window : this);