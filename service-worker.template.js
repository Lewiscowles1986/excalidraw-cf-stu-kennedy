// Generated service worker for offline-first operation.
// __PRECACHE__ and __CACHE_NAME__ are injected by the build (see the Vite
// plugin in vite.config.ts) so the service worker always caches the REAL,
// hashed asset bundle that Vite emits — never the dev-only /src/... source
// paths. Keeping the precache list correct is the build system's job.

const CACHE = '__CACHE_NAME__';

// The core app shell + the real built asset bundle. This list is filled in at
// build time from vite's .vite/manifest.json, so it stays in lockstep with
// whatever hashed files the renderer really ships.
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ),
    ),
  );
  // Take control of pages immediately so the shell is served from cache.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept API/SSE/WebSocket traffic — those are live channels.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sse/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Navigation requests: serve the cached shell, falling back to network.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        });
      }),
    );
    return;
  }

  // Other same-origin GETs (CSS, JS, images, fonts): cache-first, then fetch.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Cache successful same-origin responses.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    }).catch(() => caches.match(request)),
  );
});
