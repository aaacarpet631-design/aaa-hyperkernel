/*
 * AAA ID Factory
 *
 * Generates collision-resistant identifiers for entities and mutations.
 * IDs combine a prefix, a millisecond timestamp, a monotonic counter, and a
 * short random suffix so that two IDs minted in the same millisecond never
 * collide. Engines call createId(prefix) (e.g. 'mut', 'media') and newId().
 */
;(function (global) {
  'use strict';
  let counter = 0;

  function randomSuffix() {
    return Math.random().toString(36).slice(2, 8);
  }

  const factory = {
    /**
     * Create a prefixed id. Extra arguments are accepted and ignored so older
     * call sites such as createId('mut', []) keep working.
     * @param {string} prefix
     * @returns {string}
     */
    createId: function (prefix) {
      counter++;
      return `${prefix || 'id'}-${Date.now()}-${counter}-${randomSuffix()}`;
    },
    /** Create an unprefixed id. */
    newId: function () {
      return this.createId('id');
    }
  };
  global.AAA_ID_FACTORY = factory;
})(typeof window !== 'undefined' ? window : this);
