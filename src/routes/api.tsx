import { Hono } from 'hono';
import type { CloudflareBindings } from '../types/env';
import type { OfflineOp } from '../types/offline';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Reachability probe for offline detection (light, cheap)
app.get('/api/ping', (c) => c.json({ ok: true, t: Date.now() }));

// "Rooms you can access" — fan-out to each requested room's DrawingRoom DO
// and keep only the rooms whose `contributors` table includes this userId.
// The client supplies the candidate roomIds (from its own IndexedDB history,
// i.e. rooms the device genuinely edited on this device); the server only
// ever *filters*, it never invents rooms.
//
// Acceptance note on DO materialization: probing an unknown roomId via
// idFromName + stub.fetch does spin up an (empty) DrawingRoom DO with an
// empty SQLite file. This is accepted by design: the cap below bounds the
// blast radius to 100 rooms per request, and real clients only ever send
// roomIds from their own IndexedDB history — rooms the device already
// touched — so in practice only touched rooms are materialized.
app.post('/api/rooms/accessible', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    userId?: unknown;
    roomIds?: unknown;
  } | null;
  if (!body || typeof body.userId !== 'string' || body.userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400);
  }
  if (body.userId.length > 128) {
    return c.json({ error: 'userId must be at most 128 characters' }, 400);
  }
  if (!Array.isArray(body.roomIds) || body.roomIds.some((r) => typeof r !== 'string')) {
    return c.json({ error: 'roomIds must be an array of strings' }, 400);
  }
  const roomIds = body.roomIds as string[];
  if (roomIds.some((r) => r.length === 0 || r.length > 128)) {
    return c.json({ error: 'each roomId must be 1-128 characters' }, 400);
  }
  if (roomIds.length > 100) {
    return c.json({ error: 'too many roomIds (max 100)' }, 400);
  }

  const userId = body.userId;
  // Dedupe: a repeated roomId is one DO probe, not N.
  const unique = [...new Set(roomIds)];

  const rooms = (await Promise.all(unique.map(async (roomId) => {
    const stub = c.env.DRAWING_ROOM.get(c.env.DRAWING_ROOM.idFromName(roomId));
    try {
      // Push the filter into the room's SQLite (WHERE user_id = ?): the probe
      // fetch transfers one row, not the room's whole contributor list.
      const res = await stub.fetch(new Request(`https://do/contributors?userId=${encodeURIComponent(userId)}`));
      const data = await res.json() as { contributors?: Array<{ userId?: unknown; lastSeenAt?: unknown }>, error?: unknown };
      // A 400 here means the room rejected our userId (>128 chars) — no row
      // exists for it in that room, so filter it out (the route validates
      // the same cap up front, so this is belt-and-suspenders).
      if (!res.ok) return null;
      const contributors = Array.isArray(data.contributors) ? data.contributors : [];
      // JS-side fallback check on top of the server-side SQL filter, against
      // the filtered row shape ({ userId, lastSeenAt }).
      const mine = contributors.find((row) => row.userId === userId);
      // Only rooms the user actually edited. A room whose DO exists but never
      // recorded this user (or a never-materialized roomId) is filtered out —
      // never created, never attributed.
      if (!mine) return null;
      return { roomId, lastSeenAt: (typeof mine.lastSeenAt === 'number' ? mine.lastSeenAt : 0) || 0 };
    } catch {
      // A single room's DO failure must not fail the whole listing.
      return null;
    }
  }))).filter((room): room is { roomId: string; lastSeenAt: number } => room !== null)
    // Most recently edited first, matching the old registry listing's order.
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return c.json({ rooms });
});

// Contributor list for a room ("who has edited here") — the public surface of
// the DrawingRoom DO's internal /contributors route. Deliberately readable
// without auth (same posture as every other room route); exists for
// observability and the attribution guardrail tests.
app.get('/api/rooms/:roomId/contributors', async (c) => {
  const roomId = c.req.param('roomId');
  // Pass ?userId= through when the caller supplies it: the DO filters in SQL
  // and returns just that row. Absent, the DO returns the full list.
  const userId = c.req.query('userId');
  const qs = userId !== undefined && userId !== '' ? `?userId=${encodeURIComponent(userId)}` : '';
  const stub = c.env.DRAWING_ROOM.get(c.env.DRAWING_ROOM.idFromName(roomId));
  const res = await stub.fetch(new Request(`https://do/contributors${qs}`));
  return c.json(await res.json());
});

// Full snapshot + revision metadata for offline reconciliation
app.get('/api/rooms/:roomId/state', async (c) => {
  const roomId = c.req.param('roomId');
  const stub = c.env.DRAWING_ROOM.get(c.env.DRAWING_ROOM.idFromName(roomId));
  const res = await stub.fetch(new Request('https://do/state'));
  return c.json(await res.json());
});

// Offline outbox replay (optimistic; reports divergence if base revision stale)
app.put('/api/rooms/:roomId/events', async (c) => {
  const roomId = c.req.param('roomId');
  const stub = c.env.DRAWING_ROOM.get(c.env.DRAWING_ROOM.idFromName(roomId));
  const body = await c.req.json();
  const res = await stub.fetch(new Request('https://do/events', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return c.json(await res.json());
});

// Batch outbox drain for MULTIPLE rooms in one round-trip. The request is the
// client's whole pending registry: for every room, the same optimistic replay
// the single-room PUT /events route performs (ops + baseRevision forwarded to
// the room's Durable Object unchanged — no new revision semantics here).
//
// Body: { rooms: [{ roomId, ops, baseRevision, userId? }] }
//   — userId, when present, is forwarded so HTTP replays attribute edits to
//   the device that queued them (same contract as PUT /events).
//   — capped at 20 rooms per batch; exceeding it is an outright 400 (the
//   client is expected to split or defer, not to silently drop rooms).
// Response: { results: [{ roomId, ok, diverged?, revision?, lastEditAt?, state? }] }
app.post('/api/sync/drain', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    rooms?: Array<{ roomId: string; ops: OfflineOp[]; baseRevision: number; userId?: string }>;
  } | null;
  if (!body || !Array.isArray(body.rooms)) {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (body.rooms.length > 20) {
    return c.json({ error: 'too many rooms in one drain batch (max 20)' }, 400);
  }

  const results = await Promise.all(body.rooms.map(async ({ roomId, ops, baseRevision, userId }) => {
    const stub = c.env.DRAWING_ROOM.get(c.env.DRAWING_ROOM.idFromName(roomId));
    try {
      const res = await stub.fetch(new Request('https://do/events', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops, baseRevision, userId }),
      }));
      const data = await res.json() as Record<string, unknown>;
      return { roomId, ...data };
    } catch (e) {
      // A single room's DO failure must not fail the whole batch: surface it
      // as a per-room error entry so the client retries just that room.
      return { roomId, ok: false, error: String(e) };
    }
  }));

  return c.json({ results });
});

// Get all elements for a room
app.get('/api/rooms/:roomId/elements', async (c) => {
  const roomId = c.req.param('roomId');
  const id = c.env.DRAWING_ROOM.idFromName(roomId);
  const stub = c.env.DRAWING_ROOM.get(id);

  const res = await stub.fetch(new Request('https://do/elements'));
  const elements = await res.json();
  return c.json(elements);
});

// Update elements for a room
app.put('/api/rooms/:roomId/elements', async (c) => {
  const roomId = c.req.param('roomId');
  const id = c.env.DRAWING_ROOM.idFromName(roomId);
  const stub = c.env.DRAWING_ROOM.get(id);

  const body = await c.req.json();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Attribution: forward the caller's identity so the DO can record the
  // contributor (legacy HTTP backup path).
  const forwardedUserId = c.req.header('X-User-Id');
  if (forwardedUserId) headers['X-User-Id'] = forwardedUserId;
  const res = await stub.fetch(new Request('https://do/elements', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  }));
  const result = await res.json();
  return c.json(result);
});

// Export room as JSON
app.get('/api/rooms/:roomId/export', async (c) => {
  const roomId = c.req.param('roomId');
  const id = c.env.DRAWING_ROOM.idFromName(roomId);
  const stub = c.env.DRAWING_ROOM.get(id);

  const res = await stub.fetch(new Request('https://do/elements'));
  const elements = await res.json();

  return c.json({
    type: 'excalidraw',
    version: 2,
    elements,
    appState: { viewBackgroundColor: '#ffffff' },
  });
});

export default app;
