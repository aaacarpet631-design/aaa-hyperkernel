/*
 * AAA Measurement Store — crash-safe local-first persistence + cloud sync.
 *
 * Field data is saved to local storage FIRST (via AAA_DATA → localStorage) so a
 * dropped connection, backgrounded app, or dead battery never loses a reading.
 * Cloud sync (AAA_CLOUD, workspace-scoped) is best-effort and retried; on
 * conflict we keep the most-recently-updated record (last-write-wins by
 * updatedAt), which is the safe default for single-tech-per-job field capture.
 *
 * Collections: 'measurement_sessions', 'bluetooth_devices'. All reads are
 * workspace-isolated so two businesses on one device never see each other.
 */
;(function (global) {
  'use strict';

  const SESSIONS = 'measurement_sessions';
  const DEVICES = 'bluetooth_devices';

  function data() { return global.AAA_DATA; }
  function cloud() { return global.AAA_CLOUD; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function models() { return global.AAA_MEASUREMENT_MODELS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function mine(rec) { return rec && (rec.workspaceId == null || rec.workspaceId === ws()); }

  const Store = {
    SESSIONS: SESSIONS,
    DEVICES: DEVICES,

    // ---- sessions -------------------------------------------------------
    /** Persist a session locally (source of truth), then sync best-effort. */
    async saveSession(session) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const rec = models().newSession(session);   // normalize + stamp updatedAt
      await data().put(SESSIONS, rec.id, rec);
      // Best-effort cloud mirror; never blocks the caller / the quote.
      this._syncSession(rec);
      return { ok: true, session: rec };
    },

    async getSession(id) {
      if (!data()) return null;
      const r = await data().get(SESSIONS, id);
      return mine(r) ? r : null;
    },

    /** All sessions in this workspace, newest first. Optionally filter by job. */
    async listSessions(opts) {
      if (!data()) return [];
      const o = opts || {};
      let all = (await data().list(SESSIONS)).filter(mine);
      if (o.jobId != null) all = all.filter((s) => s.jobId === String(o.jobId));
      if (o.customerId != null) all = all.filter((s) => s.customerId === String(o.customerId));
      return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async deleteSession(id) {
      if (!data()) return { ok: false };
      const r = await this.getSession(id);
      if (!r) return { ok: false, error: 'NOT_FOUND' };
      // Soft-delete (tombstone) so cloud mirrors converge instead of resurrecting.
      const dead = Object.assign({}, r, { deleted: true, updatedAt: nowISO() });
      await data().put(SESSIONS, id, dead);
      this._syncSession(dead);
      return { ok: true };
    },

    // ---- devices --------------------------------------------------------
    async saveDevice(device) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const rec = models().newDevice(device);
      await data().put(DEVICES, rec.id, rec);
      this._syncDevice(rec);
      return { ok: true, device: rec };
    },

    async getDevice(id) {
      if (!data()) return null;
      const r = await data().get(DEVICES, id);
      return mine(r) ? r : null;
    },

    async listDevices() {
      if (!data()) return [];
      return (await data().list(DEVICES)).filter(mine)
        .filter((d) => !d.deleted)
        .sort((a, b) => String(b.lastConnectedAt || '').localeCompare(String(a.lastConnectedAt || '')));
    },

    /** The device we should try to reconnect to first. */
    async lastConnectedDevice() {
      const list = await this.listDevices();
      return list.find((d) => d.lastConnectedAt) || null;
    },

    async forgetDevice(id) {
      if (!data()) return { ok: false };
      const r = await this.getDevice(id);
      if (!r) return { ok: false, error: 'NOT_FOUND' };
      await data().put(DEVICES, id, Object.assign({}, r, { deleted: true, updatedAt: nowISO() }));
      return { ok: true };
    },

    // ---- sync -----------------------------------------------------------
    cloudReady() {
      try { return !!(data() && data().cloudReady && data().cloudReady()); } catch (_) { return false; }
    },

    /** Push every not-yet-synced local record to the cloud. Retry-safe. */
    async syncPending() {
      if (!this.cloudReady() || !cloud()) return { ok: false, error: 'CLOUD_UNAVAILABLE' };
      let pushed = 0, failed = 0;
      const sessions = (await data().list(SESSIONS)).filter(mine);
      for (const s of sessions) {
        if (s.syncedToCloud && !s.deleted) continue;
        const r = await this._syncSession(s);
        if (r) pushed++; else failed++;
      }
      const devices = (await data().list(DEVICES)).filter(mine);
      for (const d of devices) { if (await this._syncDevice(d)) pushed++; else failed++; }
      return { ok: failed === 0, pushed: pushed, failed: failed };
    },

    async _syncSession(rec) {
      if (!this.cloudReady() || !cloud()) return false;
      try {
        const res = await cloud().upsertEntity(SESSIONS, rec.id, rec);
        if (res && res.ok !== false) {
          // Mark synced locally without bumping updatedAt (avoid a sync loop).
          if (!rec.syncedToCloud) await data().put(SESSIONS, rec.id, Object.assign({}, rec, { syncedToCloud: true }));
          return true;
        }
      } catch (_) {}
      return false;
    },

    async _syncDevice(rec) {
      if (!this.cloudReady() || !cloud()) return false;
      try { const res = await cloud().upsertEntity(DEVICES, rec.id, rec); return !!(res && res.ok !== false); }
      catch (_) { return false; }
    },

    /**
     * Merge a record arriving from the cloud with the local copy.
     * Last-write-wins by updatedAt; returns the record that should win.
     */
    reconcile(localRec, remoteRec) {
      if (!localRec) return remoteRec;
      if (!remoteRec) return localRec;
      return String(remoteRec.updatedAt) > String(localRec.updatedAt) ? remoteRec : localRec;
    }
  };

  function nowISO() {
    const c = global.AAA_RUNTIME_CLOCK;
    return c && c.nowISO ? c.nowISO() : new Date().toISOString();
  }

  global.AAA_MEASUREMENT_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
