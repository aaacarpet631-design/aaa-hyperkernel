/*
 * AAA Sidekick Context Engine
 *
 * This module implements contextual intelligence for the On‑Site AI Sidekick. It
 * handles geolocation checks to determine when the user has arrived at a job
 * site and exposes a polling method to compare the device’s location against
 * scheduled jobs. All calculations are done locally; no external libraries or
 * network requests are used. If geolocation is unavailable or permission is
 * denied, the methods return structured error responses without throwing.
 */

;(function (global) {
  'use strict';

  /**
   * Convert degrees to radians.
   * @param {number} degrees
   * @returns {number}
   */
  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Compute the Haversine distance between two points on the Earth.
   * This function uses a fixed Earth radius and operates in meters.
   * @param {number} lat1
   * @param {number} lon1
   * @param {number} lat2
   * @param {number} lon2
   * @returns {number} distance in meters
   */
  function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    // Radius of the Earth in meters
    const R = 6371000;
    const φ1 = toRadians(lat1);
    const φ2 = toRadians(lat2);
    const Δφ = toRadians(lat2 - lat1);
    const Δλ = toRadians(lon2 - lon1);
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Request the current geolocation position as a Promise. If
   * geolocation is unavailable or the user denies permission, the
   * promise resolves with an error object rather than rejecting.
   * @returns {Promise<{ ok: true, coords: GeolocationCoordinates }|{ ok: false, error: string }>}
   */
  function getCurrentPositionSafe() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator) || !navigator.geolocation) {
        resolve({ ok: false, error: 'GEOLOCATION_UNAVAILABLE' });
        return;
      }
      // Invoke the geolocation API. The browser will prompt the user for permission.
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({ ok: true, coords: pos.coords });
        },
        (err) => {
          // err.code === 1 indicates user denied the request.
          if (err && err.code === 1) {
            resolve({ ok: false, error: 'GEOLOCATION_DENIED' });
          } else {
            resolve({ ok: false, error: 'GEOLOCATION_ERROR' });
          }
        }
      );
    });
  }

  /**
   * Determine if the current device location is within a defined threshold of
   * any job in the provided list. Jobs must include numeric `latitude` and
   * `longitude` properties. If a matching job is found within 200 meters
   * (street‑level proximity), the function returns a success object with the job
   * and distance. Otherwise, it returns `{ ok: false }`.
   *
   * @param {Array<Object>} jobs
   * @returns {Promise<{ ok: true, job: Object, distance: number }|{ ok: false, error?: string }>}
   */
  async function detectArrival(jobs) {
    // Ensure we have an array
    const list = Array.isArray(jobs) ? jobs : [];
    if (list.length === 0) {
      return { ok: false };
    }
    const posResult = await getCurrentPositionSafe();
    if (!posResult.ok) {
      return { ok: false, error: posResult.error };
    }
    const { latitude: currentLat, longitude: currentLon } = posResult.coords;
    let nearestJob = null;
    let nearestDistance = Infinity;
    for (const job of list) {
      const jobLat = Number(job.latitude);
      const jobLon = Number(job.longitude);
      // Skip if coordinates are missing or NaN
      if (!isFinite(jobLat) || !isFinite(jobLon)) {
        continue;
      }
      const distance = haversineDistanceMeters(currentLat, currentLon, jobLat, jobLon);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestJob = job;
      }
    }
    // Trigger arrival if within 200 meters (street‑level)
    if (nearestJob && nearestDistance <= 200) {
      return { ok: true, job: nearestJob, distance: nearestDistance };
    }
    return { ok: false };
  }

  /**
   * Poll the list of jobs for arrival. Filters jobs by currentState
   * ('QUOTE_OPEN' or 'SCHEDULED') and then invokes detectArrival on the
   * filtered subset. If geolocation is denied, the error is passed through.
   *
   * @param {Array<Object>} currentJobs
   * @returns {Promise<{ ok: true, job: Object, distance: number }|{ ok: false, error?: string }>}
   */
  async function pollArrival(currentJobs) {
    const filtered = (Array.isArray(currentJobs) ? currentJobs : []).filter((job) => {
      const state = job && job.currentState;
      return state === 'QUOTE_OPEN' || state === 'SCHEDULED';
    });
    return detectArrival(filtered);
  }

  // Expose the public API
  const context = {
    detectArrival,
    pollArrival
  };

  // Attach to global scope
  global.AAA_SIDEKICK_CONTEXT = context;
})(typeof window !== 'undefined' ? window : this);