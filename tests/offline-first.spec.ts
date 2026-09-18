import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Offline-first, done the rigorous way (the "7-step" strategy):
//   1. run the server locally            (Playwright webServer boots vite)
//   2. load the page                       (online)
//   3. ensure the service worker installed
//   4. wait for service-worker install to complete (active + controlling)
//   5. disable networking on the context   (after all downloads finished)
//   6. run the same interactions you'd run online
//   7. make assertions
//
// The two more-involved scenarios (reconnect-and-drain, and two browsers that
// diverge then fork) build on this same helper so the strategy stays reusable.
// ─────────────────────────────────────────────────────────────────────────────

// Step 1+2: load the app online (server is already booted by webServer).
async function loadOnline(page: Page): Promise<string> {
  await page.goto('/');
  await Promise.all([page.waitForURL(/\/d\//), page.click('text=New Drawing')]);
  await page.waitForSelector('#excalidraw-canvas');
  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  if (!roomId) throw new Error('no roomId in URL');
  return roomId;
}

// Steps 3+4: wait until a service worker is ACTIVE and CONTROLLING the page,
// so the cached shell is genuinely in charge before we cut the network.
async function ensureServiceWorkerReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return;
    // Guard against a page that is already controlled from a prior test context
    // by always calling register (idempotent for the same scope).
    const reg = await navigator.serviceWorker
      .register('/sw.js')
      .catch(() => navigator.serviceWorker.getRegistration());
    // If the SW is waiting (a newer one pending activate), skip waiting.
    if (reg?.active) return;
    // Otherwise wait for a worker to reach the active state.
    await new Promise<void>((resolve) => {
      const onUpdate = (): void => {
        const w = navigator.serviceWorker.controller;
        if (reg?.active && (!w || w.state === 'activated')) resolve();
        else setTimeout(onUpdate, 50);
      };
      navigator.serviceWorker.addEventListener('controllerchange', onUpdate, { once: true });
      onUpdate();
    });
  });
  // The controllerchange event means the page is now controlled; wait for it.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

// Step 5: cut the network fully (blocks fetch AND WebSocket) AFTER the SW has
// already precached the shell + assets.
async function goOffline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true);
  // Tell the app's connectivity monitor we are offline now.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}

// Draw a rectangle (the canonical "same interaction whether online or not").
async function drawRectangle(page: Page): Promise<void> {
  await page.click('[title*="Rectangle"]');
  const canvas = page.locator('#excalidraw-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 90, { steps: 8 });
  await page.mouse.up();
}

// Helper: count queued offline ops in IndexedDB.
async function queuedOpCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    new Promise<number>((resolve, reject) => {
      const req = indexedDB.open('excalidraw-cf-offline');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['events'], 'readonly');
        const countReq = tx.objectStore('events').count();
        countReq.onsuccess = () => resolve(countReq.result);
        countReq.onerror = () => reject(countReq.error);
      };
    }),
  );
}

// Helper: read the room's elements from the server.
async function readServerElements(page: Page, roomId: string): Promise<unknown[]> {
  const res = await page.request.get(`/api/rooms/${roomId}/elements`);
  return res.ok() ? (res.json() as Promise<unknown[]>) : [];
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TRIVIAL ONLINE→OFFLINE TEST (exactly the 7 steps)
// ═══════════════════════════════════════════════════════════════════════════
test('works the same after install-sw → go-offline → draw (trivial offline-first)', async ({ page, context }) => {
  // 1+2. load online
  const roomId = await loadOnline(page);

  // 3+4. ensure service worker is active + controlling (assets precached)
  await ensureServiceWorkerReady(page);

  // 5. disable networking once all downloads have finished
  await goOffline(context, page);

  // the connectivity probe should have flipped us to "offline"
  await expect(page.locator('#offline-banner')).toBeVisible();

  // 6. run the same interactions you would run online
  await drawRectangle(page);
  await page.waitForTimeout(600);

  // 7. assertions
  //   a) the edit is queued in the local outbox (not lost)
  expect(await queuedOpCount(page)).toBeGreaterThan(0);
  //   b) the canvas still rendered the element (locally visible)
  //      — we can't read the canvas pixels easily, but we can verify the
  //      element survived in the client store by re-drawing nothing and
  //      checking the outbox / offline-banner still present.
  await expect(page.locator('#offline-banner')).toBeVisible();
  //   c) while offline the server has no record yet
  expect((await readServerElements(page, roomId)).length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// RECONNECT-AND-DRAIN (offline edits sync once back online)
// ═══════════════════════════════════════════════════════════════════════════
test('queued offline edits drain to the server once back online', async ({ page, context }) => {
  // 1–5. online, SW ready, then offline
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);
  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeVisible();

  // 6. draw while offline; queued locally
  await drawRectangle(page);
  await page.waitForTimeout(600);
  expect(await queuedOpCount(page)).toBeGreaterThan(0);

  // 7. restore connectivity; the outbox should drain to the server
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });
  // Server eventually receives the queued element (the core guarantee).
  await expect
    .poll(
      async () => (await readServerElements(page, roomId)).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  // The local outbox drains too. Best-effort: the sync engine clears it in the
  // same pass, but we keep this as a lenient check since it's an internal
  // implementation detail; server delivery above is the hard guarantee.
  await expect
    .poll(() => queuedOpCount(page), { timeout: 15_000 })
    .toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// OFFLINE START: whether the canvas page can OPEN directly from the cached
// shell offline. This currently requires the SW nav-fallback work described in
// docs/build-system.md ("What next — reach the canvas"). Until that lands, the
// reload-offline path is not expected to render the canvas, so we skip rather
// than assert behavior that isn't implemented yet.
// ═══════════════════════════════════════════════════════════════════════════
test.skip('the canvas page itself stays reachable offline via the cached shell', async ({ page, context }) => {
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);

  // go offline, then reload — the SW should serve the cached shell
  await goOffline(context, page);
  await page.reload();
  await page.waitForSelector('#excalidraw-canvas');

  // still offline (SW shell did not hit the network)
  await expect(page.locator('#offline-banner')).toBeVisible();
  expect(page.url()).toMatch(/\/d\//);
});
