/*
 * AAA Customer Store
 *
 * Owns the customer book of record. Customers are persisted in the
 * local-first storage 'customers' collection so a name/address/contact only
 * has to be entered once and can be reused when creating jobs. All methods are
 * async to mirror the storage contract.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'customers';

  const store = {
    /** Boot is a no-op beyond ensuring storage is ready; data loads lazily. */
    async boot() {
      this.storage = global.AAA_LOCAL_FIRST_STORAGE;
      return true;
    },

    _storageOrThrow() {
      const s = this.storage || global.AAA_LOCAL_FIRST_STORAGE;
      if (!s) throw new Error('Local-first storage unavailable');
      return s;
    },

    /** All customers, sorted alphabetically by name. */
    async list() {
      const s = this._storageOrThrow();
      const all = await s.getAll(COLLECTION);
      return all.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''))
      );
    },

    /** Fetch a single customer by id. */
    async get(id) {
      const s = this._storageOrThrow();
      return s.get(COLLECTION, id);
    },

    /**
     * Create a new customer record.
     * @param {{ name: string, address?: string, phone?: string, gateCode?: string }} data
     * @returns {Promise<Object>} the persisted customer
     */
    async add(data) {
      const s = this._storageOrThrow();
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      const customer = {
        id: idFactory ? idFactory.createId('cust') : String(Date.now()),
        name: String((data && data.name) || '').trim(),
        address: (data && data.address) || '',
        phone: (data && data.phone) || '',
        gateCode: (data && data.gateCode) || '',
        createdAt: clock ? clock.now() : Date.now()
      };
      await s.put(COLLECTION, customer.id, customer);
      return customer;
    },

    /** Remove a customer by id. */
    async remove(id) {
      const s = this._storageOrThrow();
      return s.remove ? s.remove(COLLECTION, id) : false;
    }
  };

  global.AAA_CUSTOMER_STORE = store;
})(typeof window !== 'undefined' ? window : this);
