/* Run the real worker with simulated cache/network events, without a browser. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const { makeRunner, srcPath } = require('../helpers/harness');

module.exports = async function () {
  const t = makeRunner('service-worker');
  const origin = 'https://quote-test.example';
  const handlers = {}, buckets = new Map();
  let offline = false, httpFailure = false;
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  async function network(request) {
    const url = key(request);
    if (offline || url.endsWith('/manifest.json')) throw new Error('Network unavailable');
    return new Response(httpFailure ? 'Temporary error' : 'asset:' + new URL(url).pathname, { status: httpFailure ? 503 : 200 });
  }
  const caches = {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const entries = buckets.get(name);
      return {
        async add(request) { const response = await network(request); if (!response.ok) throw new Error('Bad response'); entries.set(key(request), response); },
        async put(request, response) { entries.set(key(request), response); },
        async match(request) { const response = entries.get(key(request)); return response && response.clone(); }
      };
    },
    async keys() { return [...buckets.keys()]; },
    async delete(name) { return buckets.delete(name); },
    async match(request) {
      for (const entries of buckets.values()) { const response = entries.get(key(request)); if (response) return response.clone(); }
      return undefined;
    }
  };
  vm.runInNewContext(fs.readFileSync(srcPath('sw.js'), 'utf8'), {
    URL, Response, caches, fetch: network, AbortController, setTimeout, clearTimeout,
    self: { location: { origin }, skipWaiting() {}, clients: { claim: async () => {} }, addEventListener: (name, fn) => { handlers[name] = fn; } }
  });
  async function dispatch(name, request) {
    const pending = [];
    let response;
    handlers[name]({ request, waitUntil: (p) => pending.push(p), respondWith: (p) => { response = p; } });
    const value = response ? await response : undefined;
    await Promise.all(pending);
    return { response: value, keptAlive: pending.length };
  }
  const req = (path, mode = 'same-origin') => ({ url: origin + path, method: 'GET', mode });
  await dispatch('install');
  t.ok('a failed optional asset does not prevent quote scripts from being cached', !!(await caches.match('/js/ui/quote-builder-ui.js')));
  t.ok('quote styling is cached during installation', !!(await caches.match('/css/quote-builder.css')));
  await caches.open('old-test-cache');
  await caches.open('hyperkernel-obsolete');
  await dispatch('activate');
  t.eq('activation keeps caches belonging to other apps', buckets.has('old-test-cache'), true);
  t.eq('activation removes its obsolete caches', buckets.has('hyperkernel-obsolete'), false);

  offline = true;
  t.eq('offline navigation falls back to the cached app shell', await (await dispatch('fetch', req('/reopened', 'navigate'))).response.text(), 'asset:/index.html');
  t.eq('offline quote code comes from the cache', await (await dispatch('fetch', req('/js/quotes/quote-builder.js'))).response.text(), 'asset:/js/quotes/quote-builder.js');
  t.eq('a missing offline script never receives HTML', (await dispatch('fetch', req('/missing-script.js'))).response.type, 'error');

  offline = false;
  const online = await dispatch('fetch', req('/new-asset.js'));
  t.eq('a successful fetch keeps the worker alive until its cache write finishes', online.keptAlive, 1);
  t.eq('successful responses update the offline cache', await (await caches.match('/new-asset.js')).text(), 'asset:/new-asset.js');
  httpFailure = true;
  t.eq('temporary server errors use a working offline asset', await (await dispatch('fetch', req('/new-asset.js'))).response.text(), 'asset:/new-asset.js');
  t.eq('an HTTP error cannot overwrite a good cached asset', await (await caches.match('/new-asset.js')).text(), 'asset:/new-asset.js');
  t.eq('cross-origin requests are left to the browser', (await dispatch('fetch', { url: 'https://other.example/script.js', method: 'GET' })).response, undefined);
  t.eq('write requests bypass the asset cache', (await dispatch('fetch', Object.assign(req('/api/sync'), { method: 'POST' }))).response, undefined);
  for (const path of ['/api/sync?workspace=private', '/api/receipt-blob?key=receipt', '/.netlify/functions/sync', '/customer-private-data.json']) {
    t.eq('private response bypasses caching: ' + path, (await dispatch('fetch', req(path))).response, undefined);
  }
  t.eq('authenticated GET never uses the offline cache', (await dispatch('fetch', Object.assign(req('/private.js'), { headers: new Headers({ authorization: 'Bearer session' }) }))).response, undefined);
  return t.report();
};
