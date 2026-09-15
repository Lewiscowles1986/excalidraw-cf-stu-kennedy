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

test('offline banner appears when the backend is unreachable', async ({ page }) => {
  // Intercept /api/ping so the connectivity probe fails -> offline.
  await page.route('**/api/ping', (route) => route.abort());
  await openCanvas(page);

  // Default is offline, so the banner should show.
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
