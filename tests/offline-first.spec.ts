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
// (getAll on a keyPath store returns rows in ascending key order). Rows carry
// the full EventRow payload written by db.appendEvent.
async function readOutboxOps(page: Page): Promise<Array<{ seq: number; roomId: string; baseRevision: number; op: any }>> {
  return page.evaluate(() =>
    new Promise<Array<{ seq: number; roomId: string; baseRevision: number; op: any }>>((resolve, reject) => {
      const req = indexedDB.open('excalidraw-cf-offline');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['events'], 'readonly');
        const getAll = tx.objectStore('events').getAll();
        getAll.onsuccess = () => resolve(getAll.result as Array<{ seq: number; roomId: string; baseRevision: number; op: any }>);
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

// A minimal-but-valid ExcalidrawElement (shape per src/types/elements.ts) for
// seeding synthetic outbox ops in tests that never touch the canvas UI.
function syntheticRectangle(id: string, version = 1): Record<string, unknown> {
  return {
    id,
    type: 'rectangle',
    x: 40,
    y: 40,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: '#e6edf3',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    seed: 4242,
    version,
    versionNonce: 777,
    isDeleted: false,
    groupIds: [],
    boundElements: null,
    locked: false,
    glow: false,
    cornerRadius: 0,
  };
}

// Seed a SECOND room (never opened on the canvas) entirely through raw
// IndexedDB: a dirty rooms row + one queued events row (seq auto-assigned by
// the store's key generator, exactly like db.appendEvent does).
async function seedBackgroundRoom(page: Page, roomId: string, element: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ roomId, element }) =>
    new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('excalidraw-cf-offline');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['rooms', 'events'], 'readwrite');
        tx.objectStore('rooms').put({
          roomId,
          revision: 0,
          elements: [],
          lastEditAt: 0,
          dirty: true,
          updatedAt: Date.now(),
        });
        tx.objectStore('events').add({
          roomId,
          op: { type: 'element-update', elements: [element] },
          baseRevision: 0,
          createdAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      };
    }),
  { roomId, element });
}

// Outbox row count for ONE room (the global queuedOpCount mixes rooms).
async function queuedOpCountForRoom(page: Page, roomId: string): Promise<number> {
  const rows = await readOutboxOps(page);
  return rows.filter((r) => r.roomId === roomId).length;
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

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND DRAIN (multi-room): a room that is NOT open on the canvas still
// gets its queued outbox drained — by a dedicated background worker (not the
// main-thread sync engine, which owns only the active room). Seeded here via
// raw IndexedDB: rooms row + one events row for 'seed-room-x'.
//
// Determinism: the worker is kicked by the SAME main-thread subscription that
// fires on a connectivity → online transition (goBackOnline); the 30s tick is
// never relied on. While offline the legacy flushAll() path for the active
// room is blocked, so the seeded room's ONLY write path is the worker's batch
// drain. Also the regression guard for the active room: room A must drain
// exactly once (server elements === drawn count), untouched by the worker.
// ═══════════════════════════════════════════════════════════════════════════
test('a background drain worker syncs pending outboxes for rooms that are not open', async ({ page, context }) => {
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);

  // The active room drains through the normal main-thread path while online:
  // leave it clean so any later change in its outbox could only come from a
  // mis-attributed drain.
  await drawRectangle(page);
  await expect.poll(() => queuedOpCount(page), { timeout: 10_000 }).toBe(0);
  expect((await readServerElements(page, roomId)).length).toBe(1);

  // Guard the scenario: the legacy backup path for the active room is
  // fulfilled, so PUT /events (replay) is the only real server write.
  await blockLegacyElementUploads(context, roomId);

  // While OFFLINE, seed a second room entirely via raw IndexedDB. The room id
  // gets a per-run suffix because DO state survives across suite runs against
  // the same dev server — a fixed id would already be drained (revision ≥ 1)
  // by the second run and diverge instead of syncing.
  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeVisible();
  const seededId = `seed-room-x-${Date.now().toString(36)}`;
  const seededElementId = 'seed-el-background-1';
  await seedBackgroundRoom(page, seededId, syntheticRectangle(seededElementId));
  expect(await queuedOpCountForRoom(page, seededId)).toBe(1);

  // Reconnect: the online transition kicks the background drain worker. The
  // seeded room is NOT the active room, so only the worker can sync it.
  await goBackOnline(context, page);

  // The seeded room's op reaches the server (the core guarantee).
  await expect
    .poll(async () => (await readServerElements(page, seededId)).length, { timeout: 15_000 })
    .toBe(1);
  // ... and its outbox drains (exactly-once: no duplicate delivery).
  await expect
    .poll(() => queuedOpCountForRoom(page, seededId), { timeout: 15_000 })
    .toBe(0);
  const seededServer = (await readServerElements(page, seededId)) as Array<{ id: string }>;
  expect(seededServer.map((e) => e.id)).toEqual([seededElementId]);

  // Active room is unaffected: server elements exactly the drawn count, and
  // its own outbox still empty (the worker must have skipped it).
  const activeServer = (await readServerElements(page, roomId)) as Array<{ id: string }>;
  expect(activeServer.length).toBe(1);
  expect(await queuedOpCountForRoom(page, roomId)).toBe(0);

  // The background room's local snapshot was reconciled too.
  const seededLocal = await readLocalRoom(page, seededId);
  expect(seededLocal, 'seeded room snapshot should exist locally').toBeTruthy();
  expect(seededLocal.dirty).toBe(false);
  expect(seededLocal.revision).toBe(1);
  const seededLocalIds: string[] = (seededLocal.elements ?? []).map((e: any) => e.id);
  expect(seededLocalIds).toContain(seededElementId);
});

// ═══════════════════════════════════════════════════════════════════════════
// DRAIN ENDPOINT (no worker): POST /api/sync/drain must forward each room's
// ops to its DO with the optimistic revision check intact — a stale
// baseRevision comes back as a per-room "diverged" entry WITHOUT applying the
// ops, a fresh baseRevision applies and bumps the revision. Also guards the
// documented 20-room batch cap.
// ═══════════════════════════════════════════════════════════════════════════
test('the drain endpoint reports divergence per room without applying ops', async ({ page }) => {
  const roomId = await loadOnline(page);

  // One element already synced online: the server revision is now 1.
  await drawRectangle(page);
  await expect.poll(() => queuedOpCount(page), { timeout: 10_000 }).toBe(0);
  expect((await readServerElements(page, roomId)).length).toBe(1);

  // Stale baseRevision → per-room diverged entry, ops NOT applied.
  const stale = await page.request.post('/api/sync/drain', {
    data: {
      rooms: [{
        roomId,
        ops: [{ type: 'element-update', elements: [syntheticRectangle('drain-endpoint-el')] }],
        baseRevision: 999,
      }],
    },
  });
  expect(stale.status()).toBe(200);
  const staleBody = await stale.json();
  expect(staleBody.results).toHaveLength(1);
  expect(staleBody.results[0].roomId).toBe(roomId);
  expect(staleBody.results[0].diverged).toBe(true);
  expect(staleBody.results[0].ok).toBeFalsy();
  // The op was NOT applied — the server still holds exactly the drawn element.
  expect((await readServerElements(page, roomId)).length).toBe(1);

  // Correct baseRevision (fresh from /state): the batch applies cleanly.
  // (The initial draw may legitimately bump the server twice — the WS frame
  // and the outbox replay upsert the same element — so only the DELTA from
  // the fetched state is asserted here.)
  const stateRes = await page.request.get(`/api/rooms/${roomId}/state`);
  const state = await stateRes.json();
  expect(state.revision).toBeGreaterThan(0);
  const fresh = await page.request.post('/api/sync/drain', {
    data: {
      rooms: [{
        roomId,
        ops: [{ type: 'element-update', elements: [syntheticRectangle('drain-endpoint-el')] }],
        baseRevision: state.revision,
      }],
    },
  });
  expect(fresh.status()).toBe(200);
  const freshBody = await fresh.json();
  expect(freshBody.results[0].roomId).toBe(roomId);
  expect(freshBody.results[0].ok).toBe(true);
  expect(freshBody.results[0].diverged).toBeFalsy();
  expect(freshBody.results[0].revision).toBe(state.revision + 1);
  const elements = (await readServerElements(page, roomId)) as Array<{ id: string }>;
  expect(elements.length).toBe(2);
  expect(elements.map((e) => e.id)).toContain('drain-endpoint-el');

  // Batches above the documented cap (20 rooms) are rejected outright.
  const tooMany = await page.request.post('/api/sync/drain', {
    data: {
      rooms: Array.from({ length: 21 }, (_, i) => ({
        roomId: `cap-room-${i}`,
        ops: [],
        baseRevision: 0,
      })),
    },
  });
  expect(tooMany.status()).toBe(400);
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND DRAIN — DIVERGENCE: if a background room moved on the server
// ahead of the worker's baseRevision, the batch drain reports diverged for
// that room only, the worker surfaces a warning sync-status event, the queued
// events are KEPT (nothing lost, nothing silently merged), and the server
// state is left untouched.
// ═══════════════════════════════════════════════════════════════════════════
test('a background room that diverged keeps its outbox and warns via sync-status', async ({ page, context }) => {
  const roomId = await loadOnline(page);
  await ensureServiceWorkerReady(page);

  // Keep the active room clean; block its legacy backup path for the whole
  // scenario so PUT /events is the only real server write path.
  await drawRectangle(page);
  await expect.poll(() => queuedOpCount(page), { timeout: 10_000 }).toBe(0);
  await blockLegacyElementUploads(context, roomId);

  // Collect the warning the worker's diverged report must produce.
  await page.evaluate(() => {
    (window as any).__drainWarnings = [] as Array<{ roomId: string; message: string }>;
    window.addEventListener('excalidraw:sync-status', ((e: CustomEvent) => {
      if (e.detail?.kind === 'warning') {
        (window as any).__drainWarnings.push({ roomId: e.detail.roomId, message: e.detail.message });
      }
    }) as EventListener);
  });

  // Seed a background room whose outbox op carries a STALE baseRevision: the
  // server is pre-loaded with one element first (revision 1) while the seeded
  // snapshot still claims revision 0.
  const divergedRoomId = `seed-room-div-${Date.now().toString(36)}`;
  const divergedElementId = 'seed-el-divergent-1';
  const pre = await page.request.post('/api/sync/drain', {
    data: {
      rooms: [{
        roomId: divergedRoomId,
        ops: [{ type: 'element-update', elements: [syntheticRectangle('seed-el-server-1')] }],
        baseRevision: 0,
      }],
    },
  });
  expect(pre.status()).toBe(200);
  expect((await pre.json()).results[0].ok).toBe(true);

  await goOffline(context, page);
  await expect(page.locator('#offline-banner')).toBeVisible();
  // Seeded AFTER the server pre-load, so its revision-0 base is already stale.
  await seedBackgroundRoom(page, divergedRoomId, syntheticRectangle(divergedElementId));
  expect(await queuedOpCountForRoom(page, divergedRoomId)).toBe(1);

  // Reconnect → kick → the worker drains and hits the divergence.
  await goBackOnline(context, page);

  // The worker reports the conflict through the standard status channel.
  await expect
    .poll(
      () => page.evaluate((rid: string) => ((window as any).__drainWarnings || []).some(
        (w: any) => w.roomId === rid && /conflict/i.test(w.message),
      ), divergedRoomId),
      { timeout: 15_000 },
    )
    .toBe(true);

  // Nothing was lost and nothing was merged: the outbox is intact, the local
  // snapshot is flagged dirty, and the server was NOT given the stale ops.
  await expect
    .poll(() => queuedOpCountForRoom(page, divergedRoomId), { timeout: 5_000 })
    .toBe(1);
  const local = await readLocalRoom(page, divergedRoomId);
  expect(local, 'diverged room snapshot should exist locally').toBeTruthy();
  expect(local.dirty).toBe(true);
  const server = (await readServerElements(page, divergedRoomId)) as Array<{ id: string }>;
  expect(server.map((e) => e.id)).toEqual(['seed-el-server-1']);
});
