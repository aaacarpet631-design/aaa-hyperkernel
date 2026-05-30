/**
 * AAA_NEW_JOB_FLOW_UI - job flow UI utilities.
 *
 * The buildJobRecord function constructs a job record for a new job.
 * It silently captures device coordinates at creation time.  When geolocation
 * permissions are denied or unavailable, it still returns a valid record
 * with latitude and longitude set to null.  The function is asynchronous
 * because navigator.geolocation.getCurrentPosition is asynchronous.
 */

/**
 * Build a job record for a new job.
 *
 * @param {Object} data - job details including serviceAddress, etc.
 * @returns {Promise<Object>} a promise that resolves to the job record.
 */
export async function buildJobRecord(data = {}) {
  const jobRecord = {
    id: typeof AAA_ID_FACTORY !== 'undefined' && AAA_ID_FACTORY.newId
      ? AAA_ID_FACTORY.newId()
      : null,
    serviceAddress: data.serviceAddress || null,
    customerName: data.customerName || null,
    scheduledDate: data.scheduledDate || null,
    createdAt:
      typeof AAA_RUNTIME_CLOCK !== 'undefined' && AAA_RUNTIME_CLOCK.now
        ? AAA_RUNTIME_CLOCK.now()
        : Date.now(),
    latitude: null,
    longitude: null,
    // copy any additional fields passed in
    ...data,
  };

  // Attempt to capture current position. This does not prevent the record
  // from being returned if geolocation is unavailable or denied.
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      const coords = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve(pos.coords),
          // On error or denial, resolve with null to avoid unhandled rejection.
          () => resolve(null),
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
        );
      });
      if (coords) {
        jobRecord.latitude = coords.latitude;
        jobRecord.longitude = coords.longitude;
      }
    } catch (_) {
      // Intentionally ignore errors. Coordinates remain null.
    }
  }

  return jobRecord;
}