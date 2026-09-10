/* Durable device backups. The saved collections are the outbox: their digest
 * is compared with the last acknowledged snapshot after reload and reconnect.
 * Acknowledgement updates only uploaded mutation IDs, never a stale queue copy.
 */
;(function (global) {
  'use strict';
  const COLLECTIONS = ['jobs', 'customers', 'quotes', 'quote_builder_working', 'audit_log', 'outcomes'];
  const cfg = () => global.AAA_CONFIG || {};
  const workspace = () => cfg().workspaceId || 'default';
  const listeners = new Set();
    const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const owner = () => global.AAA_RBAC && global.AAA_RBAC.can('MANAGE_SETTINGS');
  function session() {
    const token = cfg().firebaseProjectId ? cfg().firebaseAuthToken : cfg().accessToken;
    if (!token) return null;
    try {
      const claims = JSON.parse(global.atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return claims.sub ? { token, id: claims.sub } : null;
    } catch (_) { return null; }
  }
  const digest = value => global.AAA_BACKUP_FORMAT.digest(value);
  const messages = {
    OFFLINE: 'Offline. Your saved work will be backed up when you reconnect.',
    SIGN_IN_REQUIRED: 'Saved on this device. Sign in through Cloud Settings to enable private backups.',
    INVALID_SESSION: 'Your sign-in expired. Sign in through Cloud Settings, then retry the backup.',
    APP_AUTH_NOT_CONFIGURED: 'Saved on this device. The server administrator must configure private backup access.',
    APP_ACCESS_DENIED: 'This account does not have server backup access. Check Cloud Settings.',
    BACKUP_CONFLICT: 'A newer backup exists for this device. Review available backups before retrying.',
    BACKUP_TIMEOUT: 'Backup timed out. Your work remains saved on this device; retry when the connection improves.',
    REQUEST_TOO_LARGE: 'This backup exceeds the server size limit. Export a device copy and contact support.',
    BACKUP_FAILED: 'Backup did not finish. Your saved work remains on this device and will be retried.'
  };
  const engine = {
    COLLECTIONS, flushing: false, lastSyncAt: null, _retry: 0, _timer: null,
    status: { state: 'local', message: 'Saved work is on this device. Backup has not been confirmed.' },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _status(state, code, extra) {
      this.status = Object.assign({ state, code, lastSyncAt: this.lastSyncAt, message: messages[code] || code }, extra || {});
      for (const fn of listeners) { try { fn(this.status); } catch (_) {} }
      return this.status;
    },
    init() {
      this.storage = global.AAA_LOCAL_FIRST_STORAGE;
      if (this._bound) return;
      this._bound = true;
      if (global.addEventListener) {
        global.addEventListener('online', () => this.syncNow({ force: false }));
        global.addEventListener('offline', () => this._status('offline', 'OFFLINE'));
      }
      if (global.AAA_EVENTS) global.AAA_EVENTS.on('storage.changed', ({ collection }) => {
        if (COLLECTIONS.includes(collection) || collection === 'mutations') {
          if (!this.flushing) this._status('pending', 'Saved on this device. Backup pending.');
          this.scheduleFlush(3000);
        }
      });
      if (global.AAA_EVENTS) global.AAA_EVENTS.on('config.changed', ({ keys }) => {
        if (keys.some(k => ['workspaceId', 'firebaseAuthToken', 'accessToken', 'firebaseProjectId', 'role'].includes(k))) {
          this._scope = null; this.lastSyncAt = null;
          this._status('local', 'Saved on this device. Checking backup access for this account and workspace.');
          this.scheduleFlush(1000);
        }
      });
      this.scheduleFlush(1500);
      this._interval = setInterval(() => this.syncNow({ force: false }), 60000);
    },
    isOnline() { return !global.navigator || global.navigator.onLine !== false; },
    scheduleFlush(delay) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this.syncNow({ force: false }); }, delay);
    },
    async _snapshot(ws) {
      const storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      return storage.withCollections(COLLECTIONS, async () => {
      const collections = {}; let unscoped = 0;
      for (const name of COLLECTIONS) {
        const all = await storage.entries(name);
        collections[name] = Object.fromEntries(Object.entries(all).filter(([, row]) => {
          if (!record(row)) return false;
          if (row.workspaceId == null && ws !== 'default') unscoped++;
          return row.workspaceId === ws || row.workspaceId == null && ws === 'default';
        }).map(([key, row]) => [key, Object.assign({}, row, { workspaceId: ws })]));
      }
      return { collections, unscoped };
      });
    },
    async _request(method, auth, body, query) {
      const endpoint = cfg().syncEndpoint || '/api/sync';
      const target = new URL(endpoint, global.location && global.location.href || 'https://app.local');
      if (global.location && target.origin !== global.location.origin) throw Object.assign(new Error('BACKUP_ENDPOINT_MUST_BE_SAME_ORIGIN'), { code: 'BACKUP_ENDPOINT_MUST_BE_SAME_ORIGIN' });
      for (const [k, v] of Object.entries(query || {})) target.searchParams.set(k, v);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await global.fetch(target.href, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
          body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store', redirect: 'error' });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.error || 'BACKUP_FAILED'), { code: result.error || 'BACKUP_FAILED', status: response.status });
        return result;
      } catch (err) {
        if (controller.signal.aborted) throw Object.assign(new Error('BACKUP_TIMEOUT'), { code: 'BACKUP_TIMEOUT' });
        throw err;
      } finally { clearTimeout(timer); }
    },
    async syncNow(opts) {
      const storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      if (!storage) return { ok: false, error: 'STORAGE_UNAVAILABLE' };
      if (this.flushing) return { ok: false, error: 'BUSY' };
      if (!owner()) return { ok: false, error: 'FORBIDDEN' };
      const auth = session(), ws = workspace();
      const scope = ws + ':' + (auth && auth.id || 'signed-out');
      if (this._scope !== scope) { this._scope = scope; this.lastSyncAt = null; this._retry = 0; }
      if (!this.isOnline() || !auth) {
        const error = !this.isOnline() ? 'OFFLINE' : 'SIGN_IN_REQUIRED';
        this._status(error === 'OFFLINE' ? 'offline' : 'local', error);
        return { ok: false, error };
      }
      this.flushing = true;
      try {
        return await storage.exclusive('backup:' + ws, async () => {
          const key = ws + ':' + auth.id;
          const snapshot = await this._snapshot(ws);
          const fingerprint = await digest(snapshot.collections);
          const queue = await storage.getMutations();
          const pending = queue.filter(m => m && m.syncStatus !== 'SYNCED' && (m.workspaceId === ws || m.workspaceId == null && ws === 'default')).slice(0, 2000)
            .map(m => Object.assign({}, m, { workspaceId: ws }));
          const previous = await storage.get('backup_meta', key);
          if (opts && opts.force === false && previous && previous.digest === fingerprint && !pending.length) {
            this.lastSyncAt = previous.lastSyncAt;
            this._status('backed_up', 'Backup confirmed.', { unscoped: snapshot.unscoped });
            return { ok: true, unchanged: true };
          }
          const meta = await storage.update('backup_meta', key, (old) => Object.assign({}, old, {
            deviceId: old && old.deviceId || global.crypto.randomUUID(), generation: (old && old.generation || 0) + 1
          }), { requirePersistent: true });
          this._status('uploading', 'Backing up saved work…');
          const payload = { version: 2, workspaceId: ws, deviceId: meta.deviceId, generation: meta.generation, collections: snapshot.collections, mutations: pending };
          const result = await this._request('POST', auth, payload);
          const ids = pending.map(m => m.mutationId), accepted = result.acceptedIds;
          if (result.generation !== meta.generation || !Array.isArray(accepted) || accepted.length !== ids.length || new Set(accepted).size !== ids.length || accepted.some(id => !ids.includes(id)) || !Number.isFinite(Date.parse(result.savedAt))) {
            throw new Error('Backup acknowledgement could not be verified.');
          }
          if (ids.length) await storage.acknowledgeMutations(ids);
          this.lastSyncAt = result.savedAt;
          await storage.update('backup_meta', key, (current) => Object.assign({}, current, { digest: fingerprint, lastSyncAt: result.savedAt }), { requirePersistent: true });
          if (workspace() !== ws || (session() || {}).id !== auth.id) {
            this.lastSyncAt = null;
            this._status('local', 'Saved on this device. Backup confirmation belongs to the previous account or workspace.');
            return { ok: true, pushed: ids.length, savedAt: result.savedAt };
          }
          this._retry = 0;
          const changed = await digest((await this._snapshot(ws)).collections) !== fingerprint;
          this._status(changed ? 'pending' : 'backed_up', changed ? 'Newer changes are saved on this device. Another backup is pending.' : 'Backup confirmed.', { unscoped: snapshot.unscoped });
          if (changed) this.scheduleFlush(3000);
          return { ok: true, pushed: ids.length, savedAt: result.savedAt };
        });
      } catch (err) {
        const code = err.code || 'BACKUP_FAILED';
        this._status('error', code);
        if ((!err.status || err.status >= 500) && !['APP_AUTH_NOT_CONFIGURED', 'DEVICE_STORAGE_UNAVAILABLE', 'DEVICE_STORAGE_CORRUPT'].includes(code)) {
          this._retry++;
          if (this._retry <= 5) this.scheduleFlush(Math.min(60000, 2000 * Math.pow(2, this._retry - 1)));
        }
        return { ok: false, error: code };
      } finally { this.flushing = false; }
    },
    async pull(deviceId, generation) {
      if (!owner()) return { ok: false, error: 'FORBIDDEN' };
      const auth = session();
      if (!auth || !this.isOnline()) return { ok: false, error: auth ? 'OFFLINE' : 'SIGN_IN_REQUIRED' };
      try { return await this._request('GET', auth, null, Object.assign({ workspace: workspace() }, deviceId ? Object.assign({ device: deviceId }, generation ? { generation: String(generation) } : {}) : {})); }
      catch (err) { return { ok: false, error: err.code || 'BACKUP_FAILED' }; }
    },
    async exportSnapshot() {
      if (!owner()) throw new Error('Owner access required.');
      const ws = workspace();
      return global.AAA_BACKUP_FORMAT.seal({ version: 2, workspaceId: ws, exportedAt: new Date().toISOString(), collections: (await this._snapshot(ws)).collections });
    },
    async previewRestore(snapshot) {
      if (!owner()) throw new Error('Owner access required.');
      await global.AAA_BACKUP_FORMAT.verify(snapshot, workspace());
      const storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      const summary = { added: 0, kept: 0, conflicts: 0, collections: [] };
      for (const [name, rows] of Object.entries(snapshot.collections)) {
        const current = await storage.entries(name), counts = { name, added: 0, kept: 0, conflicts: 0 };
        for (const [id, row] of Object.entries(rows)) {
          if (Object.prototype.hasOwnProperty.call(current, id)) {
            counts.kept++;
            if (global.AAA_BACKUP_FORMAT.canonical(current[id]) !== global.AAA_BACKUP_FORMAT.canonical(row)) counts.conflicts++;
          } else counts.added++;
        }
        summary.collections.push(counts);
        for (const key of ['added', 'kept', 'conflicts']) summary[key] += counts[key];
      }
      return summary;
    },
    async restore(snapshot) {
      if (!owner() || !global.AAA_RUNTIME_GATEWAY) return { ok: false, error: 'FORBIDDEN' };
      const ws = workspace(), storage = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      try { await global.AAA_BACKUP_FORMAT.verify(snapshot, ws); }
      catch (err) { return { ok: false, error: 'INVALID_BACKUP', message: err.message }; }
      return global.AAA_RUNTIME_GATEWAY.run({ action: 'RESTORE_BACKUP', origin: 'human', detail: { deviceId: snapshot.deviceId || 'file', checksum: snapshot.checksum }, mutate: async () => {
        // Preserve the entire verified incoming copy before adding records. On
        // an interrupted restore, retrying safely skips already added records.
        await storage.put('restore_archives', snapshot.checksum, snapshot, { requirePersistent: true });
        let added = 0, kept = 0;
        for (const [name, rows] of Object.entries(snapshot.collections)) {
          await storage.exclusive('collection:' + name, () => {
            const current = storage._read(name), next = Object.assign({}, current);
            let changes = 0;
            for (const [key, row] of Object.entries(rows)) {
              if (Object.prototype.hasOwnProperty.call(current, key)) { kept++; continue; }
              next[key] = row; changes++;
            }
            if (changes) storage._commit(name, next, current, { requirePersistent: true });
            added += changes;
          });
        }
        return { added, kept, archiveId: snapshot.checksum };
      } });
    }

  };
  global.AAA_SYNC_ENGINE = engine;
})(typeof window !== 'undefined' ? window : this);
