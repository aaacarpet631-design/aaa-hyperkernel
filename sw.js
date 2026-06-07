/*
 * AAA HyperKernel Service Worker
 *
 * Network-first for same-origin GET requests so a fresh deploy is always
 * picked up when the device is online, with a cache fallback that keeps the
 * app fully usable offline. Old caches are purged on activate, and the worker
 * takes control immediately to avoid serving a stale shell after an update.
 */
const CACHE_NAME = 'hyperkernel-v74';
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
  '/js/core/aaa-security.js',
  '/js/core/aaa-privacy.js',
  '/js/core/aaa-events.js',
  '/js/core/aaa-event-bus.js',
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
  '/js/accounting/expense-classifier.js',
  '/js/accounting/receipt-intake-store.js',
  '/js/accounting/receipt-intelligence-engine.js',
  '/js/accounting/controller-agent.js',
  '/js/accounting/quickbooks-export.js',
  '/js/accounting/quickbooks-online.js',
  '/js/contracts/contract-store.js',
  '/js/portal/portal-link-store.js',
  '/js/scheduling/schedule-store.js',
  '/js/legal/legal-store.js',
  '/js/legal/legal-risk-engine.js',
  '/js/legal/legal-division.js',
  '/js/ui/legal-war-room-ui.js',
  '/js/ui/crew-ui.js',
  '/js/ui/contracts-ui.js',
  '/js/ui/schedule-ui.js',
  '/js/ui/ui-kit.js',
  '/js/agents/model-router.js',
  '/js/agents/action-safety-gate.js',
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
  '/js/agents/research-brain.js',
  '/js/agents/estimator-agent.js',
  '/js/quotes/quote-store.js',
  '/js/agents/pricing-optimizer.js',
  '/js/intelligence/analysis-division.js',
  '/js/intelligence/intelligence-collectors.js',
  '/js/intelligence/debate-engine.js',
  '/js/intelligence/intelligence-pipeline.js',
  '/js/intelligence/supervisor-council.js',
  '/js/intelligence/intelligence-meetings.js',
  '/js/intelligence/analyst-rankings.js',
  '/js/intelligence/evolution-engine.js',
  '/js/intelligence/outcome-learning-store.js',
  '/js/intelligence/prediction-closure.js',
  '/js/intelligence/calibration-registry.js',
  '/js/intelligence/agent-council.js',
  '/js/intelligence/reliability-center.js',
  '/js/intelligence/outcome-intelligence.js',
  '/js/intelligence/executive-council.js',
  '/js/intelligence/learning-fabric.js',
  '/js/intelligence/business-digital-twin.js',
  '/js/intelligence/financial-intelligence.js',
  '/js/intelligence/ai-operations-center.js',
  '/js/intelligence/proposal-engine.js',
  '/js/intelligence/agent-evaluation-lab.js',
  '/js/intelligence/knowledge-fabric.js',
  '/js/intelligence/owner-copilot.js',
  '/js/intelligence/signal-ingest.js',
  '/js/intelligence/hypermind-core.js',
  '/js/intelligence/native-model.js',
  '/js/ai/model-registry.js',
  '/js/ai/providers/nvidia-nemotron-adapter.js',
  '/js/ai/providers/nemotron-transport.js',
  '/js/ai/providers/private-gpu-adapter.js',
  '/js/ai/providers/private-gpu-transport.js',
  '/js/ai/model-call-provenance.js',
  '/js/ai/model-router.js',
  '/js/ai/assisted-draft-queue.js',
  '/js/intelligence/provenance-store.js',
  '/js/intelligence/provenance-builder.js',
  '/js/intelligence/governance-registry.js',
  '/js/intelligence/replay-sandbox.js',
  '/js/transport/template-registry.js',
  '/js/transport/providers.js',
  '/js/transport/transport-store.js',
  '/js/transport/transport-scheduler.js',
  '/js/transport/transport-adapters.js',
  '/js/transport/transport-core.js',
  '/js/ui/intelligence-dashboard-ui.js',
  '/js/ui/customer-picker-ui.js',
  '/js/ui/new-job-flow-ui.js',
  '/js/ui/voice-hud-ui.js',
  '/js/ui/vision-hud-ui.js',
  '/js/ui/closure-hud-ui.js',
  '/js/ui/command-center-ui.js',
  '/js/ui/challenge-ui.js',
  '/js/ui/prediction-ledger-ui.js',
  '/js/ui/business-ui.js',
  '/js/ui/receipt-intake-ui.js',
  '/js/ui/financial-intelligence-ui.js',
  '/js/ui/estimator-ui.js',
  '/js/ui/quote-lifecycle-ui.js',
  '/js/ui/quote-win-probability-ui.js',
  '/js/ui/pricing-optimizer-ui.js',
  '/js/ui/learning-feedback-ui.js',
  '/js/ui/calibration-ui.js',
  '/js/ui/transport-dashboard-ui.js',
  '/js/ui/transport-inbox-ui.js',
  '/js/ui/security-center-ui.js',
  '/js/ui/event-stream-ui.js',
  '/js/ui/privacy-dashboard-ui.js',
  '/js/ui/reliability-command-center-ui.js',
  '/js/ui/outcome-intelligence-ui.js',
  '/js/ui/executive-council-ui.js',
  '/js/ui/learning-fabric-ui.js',
  '/js/ui/business-digital-twin-ui.js',
  '/js/ui/financial-intelligence-suite-ui.js',
  '/js/ui/ai-operations-center-ui.js',
  '/js/ui/proposal-review-ui.js',
  '/js/ui/agent-evaluation-ui.js',
  '/js/ui/knowledge-os-ui.js',
  '/js/ui/owner-copilot-ui.js',
  '/js/ui/native-model-ui.js',
  '/js/ui/model-governance-ui.js',
  '/js/ui/assisted-drafts-ui.js',
  '/js/ui/agent-council-ui.js',
  '/js/ui/provenance-ui.js',
  '/js/ui/governance-registry-ui.js',
  '/js/ui/replay-sandbox-ui.js',
  '/js/ui/job-list-ui.js',
  '/js/ai/sidekick-context-engine.js',
  '/js/ai/voice-diagnostics.js',
  '/js/ai/voice-note-store.js',
  '/js/ai/sidekick-voice-engine.js',
  '/js/ai/sidekick-vision-engine.js',
  '/js/ai/sidekick-closure-engine.js',
  '/js/measurements/models/measurement-models.js',
  '/js/measurements/storage/measurement-store.js',
  '/js/measurements/capture-sequencer.js',
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
