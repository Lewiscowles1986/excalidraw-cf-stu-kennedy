// Service worker for offline-first operation.
// Precaches static assets so the app can boot without a network, then
// serves the cached shell cache-first. API and WebSocket requests are
// never cached (they change live state).

const CACHE = 'excalidraw-cf-v1';

// The core app shell. We cache the document, styles, and the main client
// bundle. In dev/Vite these paths differ; the runtime install step below
// caches the actual responses we first encounter.
const PRECACHE = [
  '/',
  '/src/style.css',
  '/src/client/canvas.ts',
];

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
