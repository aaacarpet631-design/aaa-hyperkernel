// runtime-clock.js stub for AAA HyperKernel
;(function(global){
  'use strict';
  const clock = {
    nowISO: function() {
      return new Date().toISOString();
    }
  };
  global.AAA_RUNTIME_CLOCK = clock;
})(typeof window !== 'undefined' ? window : this);
