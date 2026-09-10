/* Local-first records. Re-read durable state before every operation; serialize
 * read/modify/write across same-origin tabs with Web Locks when available.
 * Critical writes fail visibly on quota, corruption or revision conflicts.
 * Legacy noncritical callers retain the in-memory fallback when storage fails.
 */
;(function (global) {
  'use strict';
  const PREFIX = 'aaa:';
  const pending = new Map();
  const copy = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function error(code, message) { const e = new Error(message || code); e.code = code; return e; }
  function validKey(k) {
    if (typeof k !== 'string' || !k || ['__proto__', 'constructor', 'prototype'].includes(k)) throw error('INVALID_STORAGE_KEY');
  }
  function local() { try { return global.localStorage || null; } catch (_) { return null; } }

  const storage = {
    data: {}, booted: false,
    async boot(config) {
      this.config = config || {}; this.data = {}; this._volatile = new Set(); this._volatileEdits = new Map();
      const ls = local();
      if (ls) for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (key && key.startsWith(PREFIX)) {
          try { this._read(key.slice(PREFIX.length)); } catch (_) { /* Preserve corrupt bytes for recovery. */ }
        }
      }
      if (!this.data.mutations) this.data.mutations = [];
      if (this._channel) this._channel.close();
      if (global.document && global.BroadcastChannel) {
        this._channel = new global.BroadcastChannel('aaa:storage');
        this._channel.onmessage = ({ data }) => {
          if (data && typeof data.collection === 'string' && global.AAA_EVENTS) global.AAA_EVENTS.emit('storage.changed', { collection: data.collection, external: true });
        };
      }
      this.booted = true;
      return true;
    },
    _read(collection) {
      validKey(collection);
      const ls = local();
      if (ls) {
        let raw;
        try { raw = ls.getItem(PREFIX + collection); }
        catch (_) { throw error('DEVICE_STORAGE_UNAVAILABLE', 'Device storage cannot be read. Reopen the app and retry.'); }
        if (raw != null) {
          let value;
          try { value = JSON.parse(raw); } catch (_) { throw error('DEVICE_STORAGE_CORRUPT', 'Saved data could not be read. Keep this device’s data and contact support.'); }
          if (!value || typeof value !== 'object') throw error('DEVICE_STORAGE_CORRUPT');
          this.data[collection] = collection === 'mutations' && !Array.isArray(value) ? Object.values(value) : value;
        } else {
          delete this.data[collection];
        }
      }
      // Overlay only unsaved keys, preserving unrelated durable writes from
      // other tabs even after this tab encountered a quota failure.
      const edits = this._volatileEdits && this._volatileEdits.get(collection);
      if (edits) {
        const current = Object.assign({}, this.data[collection]);
        for (const [key, value] of edits) { if (value === undefined) delete current[key]; else current[key] = value; }
        this.data[collection] = current;
      }
      return this.data[collection] || (collection === 'mutations' ? [] : {});
    },
    _flush(collection) {
      try {
        const ls = local(); if (!ls) return false;
        ls.setItem(PREFIX + collection, JSON.stringify(this.data[collection]));
        if (this._volatile) this._volatile.delete(collection);
        if (this._volatileEdits) this._volatileEdits.delete(collection);
        return true;
      } catch (_) { return false; }
    },
    // Web Locks release on failure or tab closure. The fallback serializes this
    // runtime only; cross-tab guarantees require a supporting browser.
    async exclusive(name, task) {
      const locks = global.navigator && global.navigator.locks;
      if (locks && typeof locks.request === 'function') return locks.request(PREFIX + name, task);
      const result = (pending.get(name) || Promise.resolve()).catch(() => {}).then(task);
      pending.set(name, result);
      try { return await result; } finally { if (pending.get(name) === result) pending.delete(name); }
    },
    async withCollections(collections, task) {
      const names = [...new Set(collections)].sort();
      const acquire = index => index === names.length ? task() : this.exclusive('collection:' + names[index], () => acquire(index + 1));
      return acquire(0);
    },
    async get(collection, key) {
      validKey(key);
      const col = this._read(collection);
      return own(col, key) ? copy(col[key]) : null;
    },
    async getAll(collection) { return copy(Object.values(this._read(collection))); },
    async entries(collection) { return copy(this._read(collection)); },
    async update(collection, key, updater, opts) {
      validKey(key);
      return this.exclusive('collection:' + collection, () => {
        const previous = this._read(collection);
        const current = own(previous, key) ? previous[key] : null;
        if (opts && opts.expectedRevision != null && (current ? current.revision || 1 : 0) !== opts.expectedRevision) {
          throw error('REVISION_CONFLICT', 'This quote changed in another tab. Reopen the latest saved version or keep your changes as a new quote.');
        }
        const value = updater(copy(current));
        if (value && typeof value.then === 'function') throw error('ASYNC_STORAGE_UPDATE');
        const next = Object.assign({}, previous);
        if (value === undefined) delete next[key]; else next[key] = copy(value);
        this._commit(collection, next, previous, opts);
        return copy(value);
      });
    },
    _commit(collection, next, previous, opts) {
      this.data[collection] = next;
      if (!this._flush(collection)) {
        if (opts && opts.requirePersistent) {
          this.data[collection] = previous;
          throw error('DEVICE_STORAGE_UNAVAILABLE', 'This change could not be saved on this device. Free storage and retry.');
        }
        if (!this._volatile) this._volatile = new Set();
        this._volatile.add(collection);
        if (!this._volatileEdits) this._volatileEdits = new Map();
        const edits = this._volatileEdits.get(collection) || new Map();
        for (const key of new Set(Object.keys(previous).concat(Object.keys(next)))) {
          if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) edits.set(key, next[key]);
        }
        this._volatileEdits.set(collection, edits);
      }
      try { if (global.AAA_EVENTS) global.AAA_EVENTS.emit('storage.changed', { collection }); } catch (_) {}
      try { if (this._channel) this._channel.postMessage({ collection }); } catch (_) {}
    },
    async put(collection, key, value, opts) { return this.update(collection, key, () => value, opts); },
    async remove(collection, key, opts) {
      let removed = false;
      await this.update(collection, key, (current) => { removed = current != null; return undefined; }, opts);
      return removed;
    },
    async queueMutation(mutation) {
      await this.exclusive('collection:mutations', () => {
        const previous = this._read('mutations');
        this._commit('mutations', previous.concat([copy(mutation)]), previous, { requirePersistent: true });
      });
      return mutation;
    },
    async getMutations() { return copy(this._read('mutations')); },
    async acknowledgeMutations(ids) {
      const accepted = new Set(ids);
      return this.exclusive('collection:mutations', () => {
        const previous = this._read('mutations');
        const next = previous.map((m) => m && accepted.has(m.mutationId) ? Object.assign({}, m, { syncStatus: 'SYNCED' }) : m);
        this._commit('mutations', next, previous, { requirePersistent: true });
        return copy(next);
      });
    },
    // Retained for explicit queue maintenance. Backup acknowledgement must use
    // acknowledgeMutations so work queued during a request cannot disappear.
    async setMutations(mutations) {
      return this.exclusive('collection:mutations', () => {
        this._commit('mutations', copy(Array.isArray(mutations) ? mutations : []), this._read('mutations'), { requirePersistent: true });
        return copy(this.data.mutations);
      });
    }
  };
  global.AAA_LOCAL_FIRST_STORAGE = storage;
})(typeof window !== 'undefined' ? window : this);
