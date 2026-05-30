// local-first-storage.js stub for AAA HyperKernel
;(function(global){
  'use strict';
  const storage = {
    data: {},
    async boot() {
      // stub boot
    },
    async get(collection, key) {
      const col = this.data[collection] || {};
      return col[key] || null;
    },
    async put(collection, key, value) {
      if (!this.data[collection]) this.data[collection] = {};
      this.data[collection][key] = value;
      return value;
    },
    async getAll(collection) {
      return Object.values(this.data[collection] || {});
    },
    async queueMutation(mutation) {
      if (!this.data.mutations) this.data.mutations = [];
      this.data.mutations.push(mutation);
      return mutation;
    }
  };
  global.AAA_LOCAL_FIRST_STORAGE = storage;
})(typeof window !== 'undefined' ? window : this);
