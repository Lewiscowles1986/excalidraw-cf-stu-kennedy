import { Hono } from 'hono';
import type { CloudflareBindings } from '../types/env';
import type { OfflineOp } from '../types/offline';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Reachability probe for offline detection (light, cheap)
app.get('/api/ping', (c) => c.json({ ok: true, t: Date.now() }));

// "Rooms you've edited" registry: every room where this device's userId has
// made an edit (WS or HTTP replay), most recent first. Backed by one
// RoomRegistry DO per userId. An empty history is a plain empty list — no 404.
app.get('/api/rooms', async (c) => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId is required' }, 400);
  }
  const registry = c.env.ROOM_REGISTRY.get(c.env.ROOM_REGISTRY.idFromName(userId));
  const res = await registry.fetch(new Request(`https://registry/list?userId=${encodeURIComponent(userId)}`));
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
