import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Attribution (contribution) semantics, post-registry.
//
// The app stays unauthenticated (room URLs are capabilities); a device's
// STABLE userId, minted once and kept in localStorage, is the attribution key
// for every edit it makes — live over WebSocket, via the periodic HTTP backup,
// and via the offline outbox replay. Attribution is recorded ONLY in the
// edited room's own `contributors` table (one upsert per mutation, no
// cross-room subrequests); POST /api/rooms/accessible fans out to the rooms
// the client names and returns those whose contributors include the userId.
// ─────────────────────────────────────────────────────────────────────────────

// Opens a fresh drawing room and waits for the canvas to be interactive.
// NOTE for multi-room scenarios: once this page's service worker is active
// (dev SW registers on load), later navigations in the SAME context run
// network-first (fresh SSR while online). A second room can therefore open
// in a fresh browser context for isolation (separate IndexedDB per context),
// with the stable userId seeded via addInitScript so both rooms attribute to
// the same device identity.
async function openCanvas(page: Page): Promise<string> {
  await page.goto('/');
  await Promise.all([
    page.waitForURL(/\/d\//),
    page.click('text=New Drawing'),
  ]);
  await page.waitForSelector('#excalidraw-canvas');
  return page.url().match(/\/d\/(.+)$/)?.[1] ?? '';
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

// POST /api/rooms/accessible — the attribution-filtered room listing.
async function readAccessible(
  page: Page,
  userId: string,
  roomIds: string[],
): Promise<{ rooms: Array<{ roomId: string; lastSeenAt: number }> }> {
  const res = await page.request.post('/api/rooms/accessible', {
    data: { userId, roomIds },
  });
  if (!res.ok()) return { rooms: [] };
  return res.json();
}

// GET the room DO's contributor list (via the public proxy route) — the same
// route the accessible endpoint fans out to. With `userId`, the proxy passes
// it through and the DO filters in SQL, returning only that user's row(s).
async function readContributors(
  page: Page,
  roomId: string,
  opts?: { userId?: string },
): Promise<Array<{ userId: string; lastSeenAt: number }>> {
  const qs = opts?.userId ? `?userId=${encodeURIComponent(opts.userId)}` : '';
  const res = await page.request.get(`/api/rooms/${roomId}/contributors${qs}`);
  if (!res.ok()) return [];
  const body = await res.json() as { contributors?: Array<{ userId: string; lastSeenAt: number }> };
  return body.contributors ?? [];
}

// Wait until the given room's contributors include exactly the expected
// userIds (and lastSeenAt > 0). Polls rather than sleeps so the suite stays
// fast; contributors land fire-and-forget on the WS path, so allow time.
async function waitContributors(
  page: Page,
  roomId: string,
  expectedUserIds: string[],
  timeout = 10_000,
): Promise<void> {
  await expect
    .poll(async () => {
      const rows = await readContributors(page, roomId);
      return expectedUserIds.every((uid) =>
        rows.some((r) => r.userId === uid && r.lastSeenAt > 0),
      );
    }, { timeout, intervals: [500] })
    .toBe(true);
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

test('drawing attributes the editor in the room contributors (via accessible)', async ({ page }) => {
  await openCanvas(page);
  const userId = await readStableUserId(page);
  expect(userId).toBeTruthy();
  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  await drawRectangle(page);

  // The live WS write path records the contributor immediately; the periodic
  // HTTP backup (3s) also carries the header. Poll rather than sleep so the
  // suite stays fast.
  await waitContributors(page, roomId!, [userId!]);

  // The cross-room surface: the new accessible endpoint must report this room
  // (and only this room) for this device's userId, most-recent-first shape.
  const listing = await readAccessible(page, userId!, [roomId!]);
  expect(listing.rooms).toHaveLength(1);
  expect(listing.rooms[0].roomId).toBe(roomId);
  expect(listing.rooms[0].lastSeenAt).toBeGreaterThan(0);
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
    // Nudge the connectivity monitor directly, exactly like the drain tests.
    window.dispatchEvent(new CustomEvent('excalidraw:connectivity', { detail: { online: true } }));
  });

  // The outbox replay is an HTTP PUT /events carrying the stable userId in
  // the body — the room's contributors must show it without any WS involvement.
  await waitContributors(page, roomId!, [userId!]);

  const listing = await readAccessible(page, userId!, [roomId!]);
  expect(listing.rooms.some(r => r.roomId === roomId! && r.lastSeenAt > 0)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW ENDPOINT SEMANTICS: POST /api/rooms/accessible filters by attribution.
// Rooms edited by OTHER users are excluded; never-touched roomIds are neither
// returned nor an error.
// ─────────────────────────────────────────────────────────────────────────────
test('POST /api/rooms/accessible filters by attribution and ignores unknown rooms', async ({ page, browser }) => {
  // Room A: drawn on the canvas by this device's stable userId.
  const roomA = await openCanvas(page);
  const userId = await readStableUserId(page);
  expect(userId).toBeTruthy();
  expect(roomA).toBeTruthy();
  await drawRectangle(page);
  await waitContributors(page, roomA, [userId!]);

  // Room B: a second room, also drawn by this device — in a FRESH context
  // (see openCanvas's note on SW-controlled navigations) with the SAME
  // userId seeded before boot, so the canvas WS path attributes to it.
  const bContext = await browser.newContext();
  const bPage = await bContext.newPage();
  await bPage.addInitScript((uid: string) => {
    window.localStorage.setItem('excalidraw-cf:userId', uid);
  }, userId!);
  const roomB = await openCanvas(bPage);
  expect(roomB).toBeTruthy();
  const bUserId = await readStableUserId(bPage);
  expect(bUserId).toBe(userId);
  await drawRectangle(bPage);
  await waitContributors(bPage, roomB, [userId!]);
  await bContext.close();

  // Room C: edited by a DIFFERENT userId (simulating another device/user)
  // through the raw HTTP replay path — same userId forwarding the drain
  // route performs, attributed to someone else entirely.
  const roomC = `other-user-room-${Date.now().toString(36)}`;
  const otherUserId = crypto.randomUUID().padEnd(36, '0').slice(0, 36);
  expect(otherUserId).not.toBe(userId);
  const seed = await page.request.put(`/api/rooms/${roomC}/events`, {
    data: {
      ops: [{
        type: 'element-update',
        elements: [{
          id: 'other-el-1', type: 'rectangle', x: 10, y: 10, width: 50, height: 40,
          angle: 0, strokeColor: '#000', backgroundColor: 'transparent', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, seed: 1,
          version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null,
          locked: false,
        }],
      }],
      baseRevision: 0,
      userId: otherUserId,
    },
  });
  expect(seed.ok()).toBeTruthy();
  await waitContributors(page, roomC, [otherUserId]);

  // The ?userId= push-down filter: probing roomC's contributors for the other
  // user returns exactly that row, and probing for OUR userId returns empty
  // (both via the public proxy, which forwards ?userId= to the DO).
  const otherRows = await readContributors(page, roomC, { userId: otherUserId });
  expect(otherRows).toHaveLength(1);
  expect(otherRows[0].userId).toBe(otherUserId);
  expect(otherRows[0].lastSeenAt).toBeGreaterThan(0);
  const myRows = await readContributors(page, roomC, { userId: userId! });
  expect(myRows).toEqual([]);

  // Room D: a never-created roomId — probing it must neither error nor
  // fabricate an entry.
  const roomD = 'ZZZZ-never-existed';

  const res = await page.request.post('/api/rooms/accessible', {
    data: { userId, roomIds: [roomA, roomB, roomC, roomD] },
  });
  expect(res.status()).toBe(200);
  const body = await res.json() as { rooms: Array<{ roomId: string; lastSeenAt: number }> };

  // A and B are mine; C belongs to the other user; D never existed.
  const ids = body.rooms.map(r => r.roomId);
  expect(ids).toContain(roomA);
  expect(ids).toContain(roomB);
  expect(ids).not.toContain(roomC);
  expect(ids).not.toContain(roomD);
  expect(body.rooms).toHaveLength(2);

  // Sorted by lastSeenAt DESC (most recently edited first).
  const times = body.rooms.map(r => r.lastSeenAt);
  expect([...times].sort((a, b) => b - a)).toEqual(times);
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL (write-amplification, structural post-revert): per-stroke cost is
// exactly ONE room-local upsert and ZERO subrequests (the per-user registry
// DO is gone). Asserted here as: (a) N strokes ⇒ exactly ONE contributor row
// per distinct userId in the room (last-writer-wins upsert, not N rows), with
// a sane timestamp; (b) a filesystem-level scan pins the registry's absence
// at test time — every src/do/* file, wrangler.jsonc, and env.ts are read
// from disk and must contain no registry class/binding; if the per-user
// registry DO is ever reintroduced, this test fails.
// ─────────────────────────────────────────────────────────────────────────────
test('write-amplification guardrail: 3 strokes leave ONE contributor row, no fan-out plumbing', async ({ page }) => {
  await openCanvas(page);
  const userId = await readStableUserId(page);
  expect(userId).toBeTruthy();
  const roomId = page.url().match(/\/d\/(.+)$/)?.[1];
  expect(roomId).toBeTruthy();

  // Three distinct strokes on the canvas.
  await drawRectangle(page);
  await drawRectangle(page);
  await drawRectangle(page);
  await page.waitForTimeout(600); // let fire-and-forget attribution settle

  // One upsert per MESSAGE would be fine, but the invariant we protect is:
  // the contributors table never grows per-stroke. With a single editor it
  // must hold exactly one row (INSERT OR REPLACE keyed on user_id).
  const rows = await readContributors(page, roomId!);
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(userId);
  expect(rows[0].lastSeenAt).toBeGreaterThan(0);

  // Structural half of the guardrail: the revert must be complete. Playwright
  // runs from the repo root, so paths resolve against the project root.
  // Every source under src/do/, plus the binding surface (wrangler.jsonc) and
  // the type surface (env.ts), is scanned for the registry DO.
  const doDir = path.resolve('src', 'do');
  const scanned = [
    ...readdirSync(doDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(doDir, f)),
    path.resolve('wrangler.jsonc'),
    path.resolve('src', 'types', 'env.ts'),
  ];
  expect(scanned.length).toBeGreaterThanOrEqual(3); // drawing-room.ts + 2 config/type files at minimum
  for (const file of scanned) {
    const contents = readFileSync(file, 'utf8');
    expect(contents, `${path.relative(process.cwd(), file)} must not reference the registry`).not
      .toMatch(/RoomRegistry|ROOM_REGISTRY/);
  }
  // The binding surface must carry only DrawingRoom, and the DO migration
  // list must stay at v1 (a reintroduction would add a binding/migration).
  const wrangler = readFileSync(path.resolve('wrangler.jsonc'), 'utf8');
  expect(wrangler).toContain('"class_name": "DrawingRoom"');
  expect(wrangler).not.toContain('v2');
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION: the new endpoint rejects malformed input (owner ruling: 400 on
// missing userId or invalid shapes; caps at 100 roomIds / 128-char ids).
// ─────────────────────────────────────────────────────────────────────────────
test('POST /api/rooms/accessible validates and caps its input', async ({ page }) => {
  const post = (data: unknown) => page.request.post('/api/rooms/accessible', { data });

  expect((await post({ roomIds: ['a'] })).status()).toBe(400); // missing userId
  expect((await post({ userId: '', roomIds: ['a'] })).status()).toBe(400); // empty userId
  expect((await post({ userId: 'x'.repeat(129), roomIds: [] })).status()).toBe(400); // >128 userId
  expect((await post({ userId: 'u' })).status()).toBe(400); // missing roomIds
  expect((await post({ userId: 'u', roomIds: 'nope' })).status()).toBe(400); // not an array
  expect((await post({ userId: 'u', roomIds: [42] })).status()).toBe(400); // non-string entry
  expect((await post({ userId: 'u', roomIds: [''] })).status()).toBe(400); // empty roomId
  expect((await post({ userId: 'u', roomIds: ['r'.repeat(129)] })).status()).toBe(400); // >128 roomId
  expect((await post({
    userId: 'u',
    roomIds: Array.from({ length: 101 }, (_, i) => `room-${i}`),
  })).status()).toBe(400); // over the 100-room cap

  // Exactly at the cap is fine.
  const atCap = await post({
    userId: 'u',
    roomIds: Array.from({ length: 100 }, (_, i) => `cap-room-${i}`),
  });
  expect(atCap.status()).toBe(200);
  const atCapBody = await atCap.json() as { rooms: unknown[] };
  expect(atCapBody.rooms).toEqual([]);
});