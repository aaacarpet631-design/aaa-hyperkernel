/*
 * AAA HyperKernel Service Worker
 *
 * Network-first for same-origin GET requests so a fresh deploy is always
 * picked up when the device is online, with a cache fallback that keeps the
 * app fully usable offline. Old caches are purged on activate, and the worker
 * takes control immediately to avoid serving a stale shell after an update.
 */
const CACHE_NAME = 'hyperkernel-v30';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/job-list.css',
  '/css/customer-job-flow.css',
  '/css/arrival-hud.css',
  '/css/voice-hud.css',
  '/css/vision-hud.css',
  '/css/closure-hud.css',
  '/js/core/runtime-clock.js',
  '/js/core/id-factory.js',
  '/js/core/local-first-storage.js',
  '/js/core/aaa-config.js',
  '/js/core/aaa-rbac.js',
  '/js/core/aaa-runtime-gateway.js',
  '/js/core/aaa-events.js',
  '/js/core/aaa-firebase.js',
  '/js/core/aaa-supabase.js',
  '/js/core/aaa-cloud.js',
  '/js/core/aaa-data.js',
  '/js/core/knowledge-graph.js',
  '/js/core/sync-engine.js',
  '/js/core/app-lifecycle.js',
  '/js/customers/customer-store.js',
  '/js/crew/crew-store.js',
  '/js/crew/tool-store.js',
  '/js/accounting/accounting-store.js',
  '/js/accounting/quickbooks-export.js',
  '/js/accounting/quickbooks-online.js',
  '/js/contracts/contract-store.js',
  '/js/portal/portal-link-store.js',
  '/js/scheduling/schedule-store.js',
  '/js/ui/crew-ui.js',
  '/js/ui/contracts-ui.js',
  '/js/ui/schedule-ui.js',
  '/js/ui/ui-kit.js',
  '/js/agents/agent-registry.js',
  '/js/agents/agent-os.js',
  '/js/agents/supervisor.js',
  '/js/agents/prompt-architect.js',
  '/js/agents/self-improvement.js',
  '/js/agents/agent-marketplace.js',
  '/js/agents/agent-automation.js',
  '/js/agents/review-request-engine.js',
  '/js/agents/marketing-intel.js',
  '/js/agents/job-notes-agent.js',
  '/js/intelligence/analysis-division.js',
  '/js/intelligence/intelligence-collectors.js',
  '/js/intelligence/debate-engine.js',
  '/js/intelligence/intelligence-pipeline.js',
  '/js/intelligence/supervisor-council.js',
  '/js/intelligence/intelligence-meetings.js',
  '/js/intelligence/analyst-rankings.js',
  '/js/intelligence/evolution-engine.js',
  '/js/ui/intelligence-dashboard-ui.js',
  '/js/ui/customer-picker-ui.js',
  '/js/ui/new-job-flow-ui.js',
  '/js/ui/voice-hud-ui.js',
  '/js/ui/vision-hud-ui.js',
  '/js/ui/closure-hud-ui.js',
  '/js/ui/command-center-ui.js',
  '/js/ui/business-ui.js',
  '/js/ui/job-list-ui.js',
  '/js/ai/sidekick-context-engine.js',
  '/js/ai/voice-diagnostics.js',
  '/js/ai/voice-note-store.js',
  '/js/ai/sidekick-voice-engine.js',
  '/js/ai/sidekick-vision-engine.js',
  '/js/ai/sidekick-closure-engine.js',
  '/js/measurements/models/measurement-models.js',
  '/js/measurements/storage/measurement-store.js',
  '/js/measurements/measurement-ai-assistant.js',
  '/js/bluetooth/services/raw-reading-log.js',
  '/js/bluetooth/services/measurement-parser.js',
  '/js/bluetooth/services/generic-ble-adapter.js',
  '/js/bluetooth/services/device-adapter-registry.js',
  '/js/bluetooth/services/huepar-s60-adapter.js',
  '/js/bluetooth/hooks/use-bluetooth-connection.js',
  '/js/bluetooth/screens/measurement-hud-ui.js',
  '/js/quotes/integrations/measurement-to-quote.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(req)
      .then((response) => {
        // Refresh the cache copy for offline use.
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('/index.html'))
      )
  );
});
