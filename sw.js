const CACHE_NAME = 'hyperkernel-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/job-list.css',
  '/css/customer-job-flow.css',
  '/js/core/runtime-clock.js',
  '/js/core/id-factory.js',
  '/js/core/local-first-storage.js',
  '/js/customers/customer-store.js',
  '/js/ui/customer-picker-ui.js',
  '/js/ui/new-job-flow-ui.js',
  '/js/ui/job-list-ui.js',
  '/js/ai/sidekick-context-engine.js',
  '/js/ai/sidekick-voice-engine.js',
  '/js/ai/sidekick-vision-engine.js',
  '/js/ai/sidekick-closure-engine.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
