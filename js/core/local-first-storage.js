/*
 * AAA Local-First Storage
 *
 * A small persistent key/value store that is the backbone of the local-first
 * architecture. Every collection (jobs, customers, mediaCache, mutations) is
 * held in memory for fast synchronous-feeling reads and mirrored to
 * localStorage so data survives reloads, navigation, and going offline.
 *
 * The public API is intentionally async (Promise-returning) so that a future
 * IndexedDB or network-backed implementation can be swapped in without
 * touching any caller. Writes never throw on quota/serialisation failures;
 * they degrade to in-memory-only so the UI keeps working.
 */
;(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'aaa:';
  const MUTATIONS_KEY = 'mutations';

  function hasLocalStorage() {
    try {
      return typeof global.localStorage !== 'undefined' && global.localStorage !== null;
    } catch (_) {
      return false;
    }
  }

  const storage = {
    data: {},
    booted: false,

    /**
     * Load all known collections from localStorage into memory.
     * @param {{ mode?: string }} [config]
     */
    async boot(config) {
      this.config = config || {};
      this.data = {};
      if (hasLocalStorage()) {
        for (let i = 0; i < global.localStorage.length; i++) {
          const fullKey = global.localStorage.key(i);
          if (!fullKey || fullKey.indexOf(STORAGE_PREFIX) !== 0) continue;
          const collection = fullKey.slice(STORAGE_PREFIX.length);
          try {
            this.data[collection] = JSON.parse(global.localStorage.getItem(fullKey)) || {};
          } catch (_) {
            this.data[collection] = {};
          }
        }
      }
      // Mutations live as an array; everything else is a keyed map.
      if (!Array.isArray(this.data[MUTATIONS_KEY])) {
        this.data[MUTATIONS_KEY] = this.data[MUTATIONS_KEY]
          ? Object.values(this.data[MUTATIONS_KEY])
          : [];
      }
      this.booted = true;
      return true;
    },

    /** Persist a single collection to localStorage. Never throws. */
    _flush(collection) {
      if (!hasLocalStorage()) return;
      try {
        global.localStorage.setItem(
          STORAGE_PREFIX + collection,
          JSON.stringify(this.data[collection])
        );
      } catch (err) {
        // Quota exceeded or value not serialisable: keep going in memory.
        console.warn('Storage: failed to persist collection', collection, err);
      }
    },

    /** Fetch one record by key, or null. */
    async get(collection, key) {
      const col = this.data[collection];
      return (col && col[key]) || null;
    },

    /** Insert or replace a record and persist its collection. */
    async put(collection, key, value) {
      if (!this.data[collection]) this.data[collection] = {};
      this.data[collection][key] = value;
      this._flush(collection);
      return value;
    },

    /** Return every record in a collection as an array. */
    async getAll(collection) {
      return Object.values(this.data[collection] || {});
    },

    /** Remove a record by key. */
    async remove(collection, key) {
      if (this.data[collection] && key in this.data[collection]) {
        delete this.data[collection][key];
        this._flush(collection);
        return true;
      }
      return false;
    },

    /** Append a mutation to the outbound sync queue. */
    async queueMutation(mutation) {
      if (!Array.isArray(this.data[MUTATIONS_KEY])) this.data[MUTATIONS_KEY] = [];
      this.data[MUTATIONS_KEY].push(mutation);
      this._flush(MUTATIONS_KEY);
      return mutation;
    },

    /** Read the pending mutation queue (newest last). */
    async getMutations() {
      return Array.isArray(this.data[MUTATIONS_KEY]) ? this.data[MUTATIONS_KEY].slice() : [];
    }
  };

  global.AAA_LOCAL_FIRST_STORAGE = storage;
})(typeof window !== 'undefined' ? window : this);
