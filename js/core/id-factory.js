// id-factory.js stub for AAA HyperKernel
;(function(global){
  'use strict';
  let counter = 0;
  const factory = {
    createId: function(prefix) {
      counter++;
      return `${prefix || 'id'}-${Date.now()}-${counter}`;
    },
    newId: function() {
      counter++;
      return `id-${Date.now()}-${counter}`;
    }
  };
  global.AAA_ID_FACTORY = factory;
})(typeof window !== 'undefined' ? window : this);
