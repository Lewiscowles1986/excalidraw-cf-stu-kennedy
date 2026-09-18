import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Contribution-based "rooms you've edited" registry.
//
// The app stays unauthenticated (room URLs are capabilities); the registry is
// purely a convenience: a device's STABLE userId, minted once and kept in
// localStorage, becomes the attribution key for every edit it makes — live
// over WebSocket, via the periodic HTTP backup, and via the offline outbox
// replay. GET /api/rooms?userId=X lists the rooms that device has edited.
// ─────────────────────────────────────────────────────────────────────────────

// Opens a fresh drawing room and waits for the canvas to be interactive.
async function openCanvas(page: Page): Promise<void> {
  await page.goto('/');
  await Promise.all([
    page.waitForURL(/\/d\//),
    page.click('text=New Drawing'),
  ]);
  await page.waitForSelector('#excalidraw-canvas');
}

// Draws a rectangle on the canvas using the rectangle tool.
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

// Reads the stable device identity the client keeps in localStorage.
async function readStableUserId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem('excalidraw-cf:userId'));
}

// GET /api/rooms?userId=X — the contribution registry listing.
async function readRegistry(
  page: Page,
  userId: string,
): Promise<{ rooms: Array<{ roomId: string; lastEditAt: number }> }> {
  const res = await page.request.get(`/api/rooms?userId=${encodeURIComponent(userId)}`);
  if (!res.ok()) return { rooms: [] };
  return res.json();
}

// UUID-ish: 36 chars with hyphens at the canonical positions (8-4-4-4-12).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('userId is stable across reloads', async ({ page }) => {
  await openCanvas(page);

  const first = await readStableUserId(page);
  expect(first).toBeTruthy();
  expect(first!.length).toBe(36);
  expect(UUID_RE.test(first!)).toBe(true);

  // A reload (and any number of subsequent runs on this device) must reuse
  // the exact same identity — that is what makes attribution accumulate.
  await page.reload();
  await page.waitForSelector('#excalidraw-canvas');

  const second = await readStableUserId(page);
  expect(second).toBe(first);
});

test('drawing attributes the editor and the room appears in the registry', async ({ page }) => {
  await openCanvas(page);
  const userId = await readStableUserId(page);
  expect(userId).toBeTruthy();
  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  await drawRectangle(page);

  // The live WS write path records the contributor immediately; the periodic
  // HTTP backup (3s) also carries the header. Poll rather than sleep so the
  // suite stays fast.
  await expect
    .poll(async () => (await readRegistry(page, userId!)).rooms.find(r => r.roomId === roomId!)?.lastEditAt ?? 0, {
      timeout: 10_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);
});

test('offline outbox replay attributes the edit too', async ({ page, context }: { page: Page; context: BrowserContext }) => {
  await openCanvas(page);
  const userId = await readStableUserId(page);
  expect(userId).toBeTruthy();
  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  // Go offline (block fetch + WS at the context level AND flip the app's
  // connectivity monitor — same nudge the drain tests use), draw, come back.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await drawRectangle(page);

  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });

  // The outbox replay is an HTTP PUT /events carrying the stable userId —
  // the room must show up in the registry without any WS involvement.
  await expect
    .poll(async () => {
      const listing = await readRegistry(page, userId!);
      return listing.rooms.some(r => r.roomId === roomId! && r.lastEditAt > 0);
    }, { timeout: 10_000, intervals: [500] })
    .toBe(true);
});