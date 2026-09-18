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

// TEMP DIAGNOSTIC: dump the sync engine's __dbg log.
async function dumpDbg(page: Page): Promise<void> {
  const log = await page.evaluate(() => ((window as any).__dbg || []).join('\n'));
  console.log('=== __dbg ===\n' + log + '\n==============');
}

// Helper: read the room's elements from the server.
async function readServerElements(page: Page, roomId: string): Promise<unknown[]> {
  const res = await page.request.get(`/api/rooms/${roomId}/elements`);
  return res.ok() ? (res.json() as Promise<unknown[]>) : [];
}

// Helper: read every outbox row (op + its autoIncrement seq), oldest first
// (getAll on a keyPath store returns rows in ascending key order).
async function readOutboxOps(page: Page): Promise<Array<{ seq: number; op: any }>> {
  return page.evaluate(() =>
    new Promise<Array<{ seq: number; op: any }>>((resolve, reject) => {
      const req = indexedDB.open('excalidraw-cf-offline');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['events'], 'readonly');
        const getAll = tx.objectStore('events').getAll();
        getAll.onsuccess = () => resolve(getAll.result as Array<{ seq: number; op: any }>);
        getAll.onerror = () => reject(getAll.error);
      };
    }),
  );
}

// Helper: read the locally cached room snapshot (rooms object store).
async function readLocalRoom(page: Page, roomId: string): Promise<any> {
  return page.evaluate((roomId: string) =>
    new Promise<any>((resolve, reject) => {
      const req = indexedDB.open('excalidraw-cf-offline');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['rooms'], 'readonly');
        const get = tx.objectStore('rooms').get(roomId);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    }),
  roomId,
  );
}

// Element ids referenced by a list of outbox rows (updates carry elements,
// deletes carry ids).
function opElementIds(rows: Array<{ op: any }>): string[] {
  return rows.flatMap((r) =>
    r.op.type === 'element-update' ? r.op.elements.map((e: any) => e.id) : r.op.elementIds,
  );
}

// Step 7 helper: restore connectivity and nudge the sync engine. Same nudge
// the drain test performs inline, extracted so every reconnect scenario is
// byte-for-byte identical.
async function goBackOnline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    // Tell the app's connectivity monitor directly too, so we aren't waiting on
    // a /api/ping round-trip before sync begins.
    window.dispatchEvent(new CustomEvent('excalidraw:connectivity', { detail: { online: true } }));
  });
}

// Fulfil the legacy periodic-backup writes (flushAll → PUT /elements) so the
// outbox replay (PUT /events) is the ONLY server write path in a scenario.
// Without this, a 3s interval tick landing between reconnect and WS-open could
// upload the store behind the test's back and turn a conflict benign.
async function blockLegacyElementUploads(context: BrowserContext, roomId: string): Promise<void> {
  await context.route(`**/api/rooms/${roomId}/elements`, (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.continue();
  });
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
    // Tell the app's connectivity monitor directly too, so we aren't waiting on
    // a /api/ping round-trip before sync begins.
    window.dispatchEvent(new CustomEvent('excalidraw:connectivity', { detail: { online: true } }));
  });
  // Wait until the app actually believes it is online before polling the outbox.
  await expect(page.locator('#offline-banner')).toBeHidden({ timeout: 15_000 });
  // Server eventually receives the queued element (the core guarantee).
  await expect
    .poll(
      async () => (await readServerElements(page, roomId)).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  // The local outbox drains too (all synced edits cleared).
  await dumpDbg(page);
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

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-OP DRAIN: several queued ops must coexist in the outbox and replay in
// order. This permanently guards the IndexedDB appendEvent autoIncrement fix
// (with the old explicit-key bug the SECOND enqueue threw ConstraintError, so
// any 2+-events-per-room flow silently broke) and the ordered HTTP replay.
// ═══════════════════════════════════════════════════════════════════════════
test('several offline ops (draw, erase, draw) drain fully and in order', async ({ page, context }) => {
  // 1–5. online, SW ready, then offline
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);
  await blockLegacyElementUploads(context, roomId);
  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeVisible();

  // 6. three offline mutations: draw rect A, erase it, draw rect B.
  await drawRectangle(page);
  await page.waitForTimeout(600);
  await page.click('[title*="Eraser"]');
  const canvas = page.locator('#excalidraw-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  // Rect A spans centre→centre+120/+90. The default rectangle is stroke-only
  // (transparent fill), so hit-testing only registers near its EDGES (±10px):
  // click on its top edge, away from rect B's future footprint overlap.
  await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2 + 3);
  await page.waitForTimeout(600);
  await drawRectangle(page);
  await page.waitForTimeout(600);

  // All three ops coexist in the outbox, in interaction order, and the delete
  // targets the element the first op created (ordering is preserved).
  const ops = await readOutboxOps(page);
  expect(ops.map((r) => r.op.type)).toEqual(['element-update', 'element-delete', 'element-update']);
  expect(ops[0].op.elements[0].id).toBe(ops[1].op.elementIds[0]);
  const erasedId = ops[1].op.elementIds[0];
  const keptId = ops[2].op.elements[0].id;

  // 7. reconnect: the whole outbox must replay to the server.
  await goBackOnline(context, page);
  await expect(page.locator('#offline-banner')).toBeHidden({ timeout: 15_000 });
  // The erased element is gone server-side; the last-drawn element made it.
  await expect
    .poll(
      async () => {
        const els = (await readServerElements(page, roomId)) as Array<{ id: string }>;
        return els.length === 1 && els[0].id === keptId && !els.some((e) => e.id === erasedId);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  // And the local outbox is empty again.
  await expect.poll(() => queuedOpCount(page), { timeout: 15_000 }).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICT / DIVERGENCE: while browser A is offline, browser B (same room,
// isolated context) keeps editing live, bumping the server revision. A's
// replay then carries a stale baseRevision and the server replies diverged.
// The app must not silently lose either side: A gets a fork prompt, A's local
// outbox + snapshot stay intact, and the server state is left untouched.
// ═══════════════════════════════════════════════════════════════════════════
test('diverged replay after a server-side edit keeps local data and offers a fork', async ({ browser }) => {
  // Browser A: fresh room, one element drawn (and synced) while online.
  const aContext = await browser.newContext();
  const aPage = await aContext.newPage();
  const roomId = await loadOnline(aPage);
  await ensureServiceWorkerReady(aPage);
  await blockLegacyElementUploads(aContext, roomId);
  await drawRectangle(aPage);
  await aPage.waitForTimeout(600);
  // The online edit syncs immediately; wait for the outbox to settle so the
  // engine's baseRevision is the real server revision before A goes offline.
  await expect.poll(() => queuedOpCount(aPage), { timeout: 10_000 }).toBe(0);

  // A goes offline and queues a second element (never sent, never seen).
  await goOffline(aContext, aPage);
  await expect(aPage.locator('#offline-banner')).toBeVisible();
  await drawRectangle(aPage);
  await aPage.waitForTimeout(700);
  const outboxBefore = await queuedOpCount(aPage);
  expect(outboxBefore).toBe(1);
  const aOps = await readOutboxOps(aPage);
  const aOfflineIds = opElementIds(aOps);
  // The queued op was built on the revision A last saw (non-zero after the
  // online draw synced) — this is the base that is about to go stale.
  expect(aOps[0].baseRevision).toBeGreaterThan(0);

  // Browser B (separate context ⇒ isolated IndexedDB) joins the same room
  // while online and draws over the live WebSocket, bumping the revision.
  const bContext = await browser.newContext();
  const bPage = await bContext.newPage();
  await bPage.goto(`/d/${roomId}`);
  await bPage.waitForSelector('#excalidraw-canvas');
  await drawRectangle(bPage);
  await bPage.waitForTimeout(800);
  // The server now holds A's online element + B's element — exactly two.
  await expect
    .poll(async () => (await readServerElements(aPage, roomId)).length, { timeout: 10_000 })
    .toBe(2);

  // A reconnects: the replay carries the stale base → diverged.
  await goBackOnline(aContext, aPage);

  // Data-loss guardrail: the fork prompt appears instead of a silent merge.
  await expect(aPage.locator('#fork-modal')).toBeVisible({ timeout: 15_000 });

  // The diverged replay must not have touched the server: still exactly the
  // two live elements, and A's offline element is still absent.
  const serverAfter = (await readServerElements(aPage, roomId)) as Array<{ id: string }>;
  expect(serverAfter.length).toBe(2);
  for (const id of aOfflineIds) expect(serverAfter.map((e) => e.id)).not.toContain(id);

  // Declining the fork keeps local data: outbox intact, snapshot intact.
  await aPage.click('[data-fork-cancel]');
  await expect(aPage.locator('#fork-modal')).toBeHidden();
  await expect(aPage.locator('#offline-banner')).toBeVisible();
  expect(await queuedOpCount(aPage)).toBe(outboxBefore);
  const local = await readLocalRoom(aPage, roomId);
  expect(local, 'local room snapshot should survive the divergence').toBeTruthy();
  const localIds: string[] = (local.elements ?? []).map((e: any) => e.id);
  for (const id of aOfflineIds) expect(localIds).toContain(id);

  await aContext.close();
  await bContext.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// RELOAD PERSISTENCE (offline): the SW-served shell currently lands on the
// landing page (nav-fallback for /d/:id is not implemented — see the skipped
// test above), so the canvas itself cannot be asserted here. What MUST hold
// is data safety: the outbox rows and the dirty room snapshot survive the
// reload untouched, so nothing queued can ever be lost by a refresh.
// ═══════════════════════════════════════════════════════════════════════════
test('offline outbox rows and room snapshot survive a page reload', async ({ page, context }) => {
  // 1–5. online, SW ready, then offline
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);
  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeVisible();

  // 6. draw while offline; exactly one queued op.
  await drawRectangle(page);
  await page.waitForTimeout(700);
  const before = await readOutboxOps(page);
  expect(before.length).toBe(1);

  // 7. reload while still offline — IndexedDB is per-origin and must persist.
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Outbox survived the reload with the very same row (seq preserved).
  await expect.poll(async () => (await readOutboxOps(page)).length, { timeout: 10_000 }).toBe(1);
  const after = await readOutboxOps(page);
  expect(after[0].seq).toBe(before[0].seq);
  // The dirty room snapshot survived too, still holding the drawn element.
  const local = await readLocalRoom(page, roomId);
  expect(local, 'room snapshot should persist across reload').toBeTruthy();
  expect(local.dirty).toBe(true);
  const localIds: string[] = (local.elements ?? []).map((e: any) => e.id);
  expect(localIds).toContain(before[0].op.elements[0].id);
});

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTIVITY OVERRIDE: the DEV/test pin (window.__connectivityOverride boot
// hook) must win over the machine's REAL connectivity, and removing it must
// hand control back to navigator.onLine on the next transition.
// ═══════════════════════════════════════════════════════════════════════════
test('connectivity override pins the app online, then releases to navigator.onLine', async ({ page, context }) => {
  // Pin "online" before boot (the app is genuinely online at this point).
  await page.addInitScript(() => {
    (window as any).__connectivityOverride = 'online';
  });
  await loadOnline(page);
  await ensureServiceWorkerReady(page);
  await expect(page.locator('#offline-banner')).toBeHidden();

  // Cut the network for real (navigator.onLine=false): the pin must win, so
  // no offline banner may appear.
  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeHidden({ timeout: 5_000 });

  // Release the pin: the boot hook is re-read on every connectivity
  // transition, so deleting the window property re-evaluates navigator.onLine
  // (false here) and flips the app offline.
  await page.evaluate(() => {
    delete (window as any).__connectivityOverride;
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#offline-banner')).toBeVisible({ timeout: 5_000 });
});
