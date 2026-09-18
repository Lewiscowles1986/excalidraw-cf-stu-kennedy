import { test, expect } from '@playwright/test';

// Opens a fresh drawing room and waits for the canvas to be interactive.
async function openCanvas(page): Promise<void> {
  await page.goto('/');
  await Promise.all([
    page.waitForURL(/\/d\//),
    page.click('text=New Drawing'),
  ]);
  await page.waitForSelector('#excalidraw-canvas');
}

// Draws a rectangle on the canvas using the rectangle tool.
async function drawRectangle(page): Promise<void> {
  await page.click('[title*="Rectangle"]');
  const canvas = page.locator('#excalidraw-canvas');
  const box = await canvas.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 90, { steps: 8 });
  await page.mouse.up();
}

// Reads the room's elements from the server API.
async function readServerElements(page, roomId): Promise<any[]> {
  const res = await page.request.get(`/api/rooms/${roomId}/elements`);
  return res.ok() ? res.json() : [];
}

// Counts the offline ops queued in IndexedDB for this origin.
async function queuedOpCount(page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const req = indexedDB.open('excalidraw-cf-offline');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['events'], 'readonly');
      const store = tx.objectStore('events');
      const countReq = store.count();
      countReq.onsuccess = () => resolve(countReq.result);
      countReq.onerror = () => reject(countReq.error);
    };
  }));
}

test('landing page shows the title and New Drawing action', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1.landing-title')).toHaveText('Excalidraw-CF');
  await expect(page.locator('.landing-btn.primary')).toBeVisible();
});

test('a rectangle can be drawn and is persisted to the server', async ({ page }) => {
  await openCanvas(page);

  await drawRectangle(page);

  // Give the periodic flush (3s) time to run and push to the server.
  await page.waitForTimeout(4000);

  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  // After reconnect-online, the element should be persisted server-side.
  const elements = await readServerElements(page, roomId!);
  expect(elements.length).toBeGreaterThan(0);
});

test('offline banner shows when navigator.onLine is false', async ({ page }) => {
  // navigator.onLine is the source of truth for connectivity. The init-script
  // hook below forces the "machine is offline" state before the app boots; the
  // backend here is fully reachable, so no ping probe may influence the
  // decision (a single failed /api/ping must never flip the app offline).
  await page.addInitScript(() => {
    (window as any).__connectivityOverride = 'offline';
  });
  await openCanvas(page);

  await expect(page.locator('#offline-banner')).toBeVisible();

  // Even when the browser fires 'online' (navigator.onLine is true in this
  // test), the override keeps the app offline.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#offline-banner')).toBeVisible();
});

test('edits made while offline are queued locally and not sent to the server', async ({ page, context }) => {
  await openCanvas(page);

  // Take the entire browser context offline (blocks fetch AND WebSocket).
  await context.setOffline(true);
  // Force the connectivity monitor to go offline immediately.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await expect(page.locator('#offline-banner')).toBeVisible();

  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  // Draw while offline.
  await drawRectangle(page);
  await page.waitForTimeout(800);

  // The offline op should be in the IndexedDB outbox.
  expect(await queuedOpCount(page)).toBeGreaterThan(0);

  // While offline we cannot query the server; coming back online, the queued
  // edit should NOT be lost and should drain to the server.
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });

  await expect
    .poll(async () => (await readServerElements(page, roomId!)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
});

test('offline banner reflects navigator.onLine transitions', async ({ page }) => {
  await openCanvas(page);

  // Online boot: no banner.
  await expect(page.locator('#offline-banner')).toBeHidden();

  // Browser reports offline → banner appears.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('#offline-banner')).toBeVisible();

  // Browser reports online again → banner clears.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#offline-banner')).toBeHidden();
});

test('WS reconnects after a long offline period beyond backoff exhaustion', async ({ page, context }) => {
  // Record every ws-status transition (with timestamps) from boot.
  await page.addInitScript(() => {
    (window as any).__wsLog = [] as Array<{ connected: boolean; t: number }>;
    window.addEventListener('excalidraw:ws-status', ((e: CustomEvent) => {
      (window as any).__wsLog.push({ connected: !!e.detail?.connected, t: Date.now() });
    }) as EventListener);
  });

  await openCanvas(page);

  // Initial connection established.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const log = (window as any).__wsLog as Array<{ connected: boolean }>;
        return log.some((x) => x.connected);
      }),
    )
    .toBe(true);

  // Cut the network for longer than the full backoff chain
  // (1+2+4+8+16s ⇒ attempts exhausted at ~31s; we wait 34s).
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  // The socket must be torn down while the network is provably dead.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const log = (window as any).__wsLog as Array<{ connected: boolean }>;
        return log.length > 0 && !log[log.length - 1].connected;
      }),
    )
    .toBe(true);

  await page.waitForTimeout(34_000);

  // Back online: the lifecycle guardrail must reset the exhausted backoff and
  // reconnect WITHOUT a manual connect() call.
  const restoreTs = await page.evaluate(() => {
    (window as any).__wsLog = [];
    return Date.now();
  });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(
      () =>
        page.evaluate((ts: number) => {
          const log = (window as any).__wsLog as Array<{ connected: boolean; t: number }>;
          return log.some((x) => x.connected && x.t > ts);
        }, restoreTs),
      { timeout: 5_000 },
    )
    .toBe(true);
});
