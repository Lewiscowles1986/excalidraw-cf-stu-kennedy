import { DurableObject } from 'cloudflare:workers';

// RoomRegistry — a per-user registry of "rooms this user has edited".
//
// One DurableObject instance per userId (idFromName(userId)): no global
// contention, and a user's registry is a single small SQLite table. Rows are
// written fire-and-forget-ish from DrawingRoom whenever a mutation is
// attributed to a user (live WS, HTTP PUT /events replay, HTTP PUT /elements).
//
// Failure posture: a missing binding or a registry error must never break
// drawing — DrawingRoom guards every call; this DO itself just fails loudly
// per-request and the caller swallows it.

interface RoomContributionRow {
  room_id: unknown;
  last_edit_at: unknown;
}

// Attribution ids are client-supplied (localStorage UUIDs, typed room ids).
// Cap their length so an oversized payload can never bloat the registry
// (UUIDs are 36 chars; 128 is a generous ceiling).
const MAX_ID_LENGTH = 128;

export class RoomRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_contributions (
        user_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        last_edit_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/record' && request.method === 'POST') {
      return this.handleRecord(request);
    }

    if (url.pathname === '/list' && request.method === 'GET') {
      return this.handleList(url);
    }

    if (url.pathname === '/delete' && request.method === 'POST') {
      return this.handleDelete(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /** POST /record { userId, roomId, lastEditAt } — upsert, keeping the MAX. */
  private async handleRecord(request: Request): Promise<Response> {
    let body: { userId?: string; roomId?: string; lastEditAt?: number };
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid body' }, { status: 400 });
    }

    const { userId, roomId } = body;
    const lastEditAt = typeof body.lastEditAt === 'number' ? body.lastEditAt : Date.now();

    if (!userId || !roomId) {
      return Response.json({ ok: false, error: 'userId and roomId are required' }, { status: 400 });
    }

    if (userId.length > MAX_ID_LENGTH || roomId.length > MAX_ID_LENGTH) {
      return Response.json(
        { ok: false, error: 'userId and roomId must be at most 128 characters' },
        { status: 400 }
      );
    }

    // Idempotent upsert: a replayed/duplicated attribution can never move the
    // timestamp backwards — keep the most recent edit seen.
    this.sql.exec(
      `INSERT INTO room_contributions (user_id, room_id, last_edit_at)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id, room_id)
       DO UPDATE SET last_edit_at = MAX(last_edit_at, excluded.last_edit_at)`,
      userId, roomId, lastEditAt
    );

    return Response.json({ ok: true });
  }

  /** GET /list?userId=X&limit=100 — rooms ordered by most recent edit. */
  private handleList(url: URL): Response {
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return Response.json({ ok: false, error: 'userId is required' }, { status: 400 });
    }

    // An oversized id is invalid input, not an empty history.
    if (userId.length > MAX_ID_LENGTH) {
      return Response.json({ ok: false, error: 'userId must be at most 128 characters' }, { status: 400 });
    }

    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;

    const rows = this.sql.exec(
      `SELECT room_id, last_edit_at FROM room_contributions
       WHERE user_id = ? ORDER BY last_edit_at DESC LIMIT ?`,
      userId, limit
    ).toArray() as unknown as RoomContributionRow[];

    return Response.json({
      rooms: rows.map((row) => ({
        roomId: row.room_id as string,
        lastEditAt: (row.last_edit_at as number) || 0,
      })),
    });
  }

  /** POST /delete { userId, roomId } — remove one contribution row. */
  private async handleDelete(request: Request): Promise<Response> {
    let body: { userId?: string; roomId?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid body' }, { status: 400 });
    }

    const { userId, roomId } = body;
    if (!userId || !roomId) {
      return Response.json({ ok: false, error: 'userId and roomId are required' }, { status: 400 });
    }

    if (userId.length > MAX_ID_LENGTH || roomId.length > MAX_ID_LENGTH) {
      return Response.json(
        { ok: false, error: 'userId and roomId must be at most 128 characters' },
        { status: 400 }
      );
    }

    this.sql.exec(
      'DELETE FROM room_contributions WHERE user_id = ? AND room_id = ?',
      userId, roomId
    );
    return Response.json({ ok: true });
  }
}