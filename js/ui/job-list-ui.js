// job-list-ui.js placeholder
;(function(global){
  'use strict';
  const UI = {
    async boot() {
      // placeholder
    },
    async render(containerId) {
      const el = document.getElementById(containerId);
      if (el) {
        el.innerHTML = '<h1>Job List (placeholder)</h1>';
      }
    }
  };
  global.AAA_JOB_LIST_UI = UI;
})(typeof window !== 'undefined' ? window : this);
