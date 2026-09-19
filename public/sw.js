// Static, self-contained service worker — no build-time injection.
//
// The SW builds its cache AT RUNTIME from the canonical documents it actually
// serves: install seeds the landing document '/'; every successful network
// navigation is cached under its own URL, and canvas-shaped pages are ALSO
// cached under '/shell' (the canonical roomless canvas dummy); CSS/JS/assets
// populate lazily via stale-while-revalidate as the page loads.
//
// CACHE VERSIONING: bump CACHE_VERSION on any change to this file, then let
// clients pick it up. On activate, every cache whose name !== CACHE_VERSION is
// deleted, so old caches can never linger.
const CACHE_VERSION = 'excalidraw-cf-v3-runtime';

self.addEventListener('install', (event) => {
  // Only the landing document is seeded eagerly (canonical dummy #1). Canvas
  // pages and assets enter the cache through real usage.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(['/'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ),
  );
  // Take control of pages immediately so the cache is in charge right away.
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
  //   /d/:roomId, /new, /join  → the cached '/shell' canvas document (the
  //                              client derives the room from the URL at boot —
  //                              see src/client/canvas.ts), falling back to
  //                              '/' if the shell is somehow missing;
  //   anything else            → the cached landing page '/'.
  // If neither is cached, respond with a minimal inline 503 document rather
  // than a network error.
  //
  // RUNTIME CANONICAL DOCUMENT CACHING: while online, every successful
  // navigation response is cached under its own URL, and any canvas-shaped
  // page is ALSO cached under '/shell'. That makes the cache self-seeding:
  // no build step, no precache list — using the app online warms the exact
  // documents offline boots will need.
  //
  // NOTE on '/shell': a /d/:roomId SSR page carries data-signals-room-id="<id>"
  // for the room it was rendered for. That embedded signal is INERT offline —
  // the client derives the room from location.pathname at boot (canvas.ts
  // /d/ regex) and never reads the SSR $roomId signal — so caching any
  // canvas-shaped document under '/shell' is safe. It is the canonical dummy.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            // ONE direct clone per purpose. Cloning the same response twice
            // is illegal (the first clone() locks its body, so a second
            // res.clone() throws) — the '/shell' twin is derived from the
            // first clone instead. The original res is returned to the page.
            const forRequest = res.clone();
            // Shape the '/shell' twin on the FINAL response URL (fetch follows
            // redirects, so res.url is the last URL in the chain): seed only
            // canvas-shaped final documents — /d/:id, /new, /join redirect
            // targets and /shell itself. The landing '/' is excluded, so an
            // empty join-form submit (→ 302 to '/') can never poison /shell
            // with a landing document.
            const canvasShaped = /^\/(d\/|new|join|shell)/.test(new URL(res.url).pathname);
            const forShell = canvasShaped ? forRequest.clone() : undefined;
            event.waitUntil(
              caches.open(CACHE_VERSION).then((cache) => {
                const puts = [cache.put(request, forRequest)];
                // Canvas-shaped FINAL documents (see above) also seed '/shell'
                // with their own twin (never re-use a consumed body).
                if (forShell) puts.push(cache.put('/shell', forShell));
                return Promise.all(puts);
              }),
            );
          }
          return res;
        })
        .catch(() => {
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

  // Other same-origin GETs (CSS, JS, images, fonts): stale-while-revalidate
  // lite — serve the cached copy if we have one, and refresh it in the
  // background so the next load gets fresh bytes. The first-ever request
  // populates the cache; later requests serve cache + revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchAndCache = fetch(request)
        .then((res) => {
          // Only cache successful responses — never a 4xx/5xx.
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.put(request, copy)));
          }
          return res;
        });
      if (cached) {
        event.waitUntil(fetchAndCache.catch(() => undefined));
        return cached;
      }
      return fetchAndCache.catch(() => caches.match(request));
    }),
  );
});
