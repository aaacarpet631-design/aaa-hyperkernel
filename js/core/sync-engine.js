/*
 * AAA Sync Engine
 *
 * Pushes the local-first mutation queue and entity snapshots to the /api/sync
 * function (Netlify Blobs) so a device's work is backed up off-device, and can
 * pull server state back. Local storage stays the source of truth; this layer
 * is opportunistic — it flushes when online, retries with backoff on transient
 * failure, and silently no-ops when offline so the UI never blocks on it.
 */
;(function (global) {
  'use strict';

  function endpoint() {
    return (global.AAA_CONFIG && global.AAA_CONFIG.syncEndpoint) || '/api/sync';
  }

  const engine = {
    flushing: false,
    lastSyncAt: null,
    _retry: 0,
    _timer: null,

    init() {
      this.storage = global.AAA_LOCAL_FIRST_STORAGE;
      if (this._bound) return;
      this._bound = true;
      if (typeof global.addEventListener === 'function') {
        // Flush when connectivity returns.
        global.addEventListener('online', () => this.syncNow());
      }
      // Attempt an initial flush shortly after boot, then poll for new work.
      this.scheduleFlush(1500);
      if (typeof setInterval === 'function') {
        setInterval(() => {
          const muts = this.storage && this.storage.data && this.storage.data.mutations;
          const hasPending = Array.isArray(muts) && muts.some((m) => m && m.syncStatus !== 'SYNCED');
          if (hasPending) this.syncNow();
        }, 60000);
      }
    },

    isOnline() {
      return typeof navigator === 'undefined' || navigator.onLine !== false;
    },

    scheduleFlush(delay) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.syncNow();
      }, delay);
    },

    /** Build keyed maps of the local entities for the push payload. */
    async _snapshot() {
      const storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      const jobsArr = await storage.getAll('jobs');
      const custArr = await storage.getAll('customers');
      const jobs = {};
      jobsArr.forEach((j) => { if (j && j.id) jobs[j.id] = j; });
      const customers = {};
      custArr.forEach((c) => { if (c && c.id) customers[c.id] = c; });
      return { jobs, customers };
    },

    /**
     * Push pending mutations + entity snapshots to the server. Marks pushed
     * mutations SYNCED on success. Safe to call anytime; returns a result
     * object rather than throwing.
     */
    async syncNow() {
      const storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      if (!storage) return { ok: false, error: 'STORAGE_UNAVAILABLE' };
      if (this.flushing) return { ok: false, error: 'BUSY' };
      if (!this.isOnline()) return { ok: false, error: 'OFFLINE' };

      this.flushing = true;
      try {
        const mutations = await storage.getMutations();
        const pending = mutations.filter((m) => m && m.syncStatus !== 'SYNCED');
        const snapshot = await this._snapshot();

        const res = await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobs: snapshot.jobs, customers: snapshot.customers, mutations: pending })
        });
        if (!res.ok) throw new Error('Sync HTTP ' + res.status);
        await res.json();

        // Mark everything currently queued as synced.
        if (pending.length) {
          const updated = mutations.map((m) =>
            m && m.syncStatus !== 'SYNCED' ? Object.assign({}, m, { syncStatus: 'SYNCED' }) : m
          );
          await storage.setMutations(updated);
        }
        this.lastSyncAt = Date.now();
        this._retry = 0;
        return { ok: true, pushed: pending.length };
      } catch (err) {
        // Exponential backoff up to ~1 min while there's still pending work.
        this._retry = Math.min(this._retry + 1, 5);
        const delay = Math.min(60000, 2000 * Math.pow(2, this._retry - 1));
        this.scheduleFlush(delay);
        return { ok: false, error: 'SYNC_FAILED', message: String((err && err.message) || err) };
      } finally {
        this.flushing = false;
      }
    },

    /** Pull server state (for inspection / multi-device). Does not overwrite local. */
    async pull() {
      if (!this.isOnline()) return { ok: false, error: 'OFFLINE' };
      try {
        const res = await fetch(endpoint(), { method: 'GET' });
        if (!res.ok) throw new Error('Sync HTTP ' + res.status);
        return res.json();
      } catch (err) {
        return { ok: false, error: 'PULL_FAILED', message: String((err && err.message) || err) };
      }
    }
  };

  global.AAA_SYNC_ENGINE = engine;
})(typeof window !== 'undefined' ? window : this);
