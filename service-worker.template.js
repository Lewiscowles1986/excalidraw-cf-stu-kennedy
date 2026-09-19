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

  // Navigation requests: NETWORK-FIRST with a route-aware offline fallback.
  // Online the real SSR page is served (always fresh); offline the fallback
  // document depends on the URL shape:
  //   /d/:roomId, /new, /join  → the precached '/shell' canvas document
  //                              (the client derives the room from the URL at
  //                              boot — see src/client/canvas.ts), falling
  //                              back to '/' if the shell is somehow missing;
  //   anything else            → the precached landing page '/'.
  // If neither is cached, respond with a minimal inline 503 document rather
  // than a network error.
  //
  // Navigations are deliberately NOT runtime-cached: the precache list already
  // covers the two documents ('/' and '/shell'), and the cache name churns per
  // build in dev anyway — caching fetched navigations would only risk serving
  // stale HTML the next time the network hiccups.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        const path = url.pathname;
        const canvasShaped =
          path.startsWith('/d/') || path === '/new' || path === '/join';
        return (canvasShaped ? caches.match('/shell') : Promise.resolve(undefined))
          .then((shell) => shell || caches.match('/'))
          .then(
            (cached) =>
              cached ||
              new Response(
                '<!doctype html><title>Offline</title><p>Excalidraw-CF is offline and this page was not cached. Reconnect and reload.</p>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
              ),
          );
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
