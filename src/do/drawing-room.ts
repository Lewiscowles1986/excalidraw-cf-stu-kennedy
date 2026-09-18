import { DurableObject } from 'cloudflare:workers';
import type { ExcalidrawElement } from '../types/elements';
import type { ClientMessage, ServerMessage } from '../types/protocol';

interface SessionInfo {
  userId: string;
  username: string;
  ws: WebSocket;
}

// One-line warning cap: the registry being absent (some dev/test envs) must
// warn once, not once per mutation.
let registryWarned = false;

export class DrawingRoom extends DurableObject {
  private sessions: Map<WebSocket, SessionInfo> = new Map();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  /** The DO's stable name — idFromName(roomId), i.e. the roomId itself. */
  private get roomName(): string {
    return this.ctx.id?.name ?? '';
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS elements (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS contributors (
        user_id TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (user_id)
      )
    `);
  }

  /**
   * Attribute a mutation to the user who performed it. Two writes, both
   * deliberately cheap and side-effect-free (no revision bump, no broadcast):
   *   1. the room-local `contributors` table (single INSERT OR REPLACE);
   *   2. the per-user RoomRegistry DO — one DO-to-DO fetch keyed on userId,
   *      which is what makes "rooms you've edited" queryable cross-room.
   * The registry is best-effort by design: a missing binding (dev/test without
   * the v2 migration) or a transient DO error must never break drawing.
   * Hot paths (live WS writes, PUT /elements) call this fire-and-forget
   * (`void …`) so a slow registry can never delay a broadcast; attribution
   * still lands, just asynchronously. Off-hot-path callers (offline replay)
   * may await it. userIds longer than 128 chars are skipped, not thrown on.
   */
  private async recordContributor(userId: string | null): Promise<void> {
    if (!userId || userId.length > 128) return;
    try {
      this.sql.exec(
        'INSERT OR REPLACE INTO contributors (user_id, last_seen_at) VALUES (?, ?)',
        userId, Date.now()
      );

      const registry = (this.env as any)?.ROOM_REGISTRY;
      if (!registry) {
        if (!registryWarned) {
          console.warn('[room] ROOM_REGISTRY binding not available — room attribution skipped');
          registryWarned = true;
        }
        return;
      }
      const stub = registry.get(registry.idFromName(userId));
      const res = await stub.fetch(new Request('https://registry/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, roomId: this.roomName, lastEditAt: Date.now() }),
      }));
      if (!res.ok) throw new Error(`registry /record → ${res.status}`);
    } catch (e) {
      if (!registryWarned) {
        console.warn('[room] failed to record room attribution', e);
        registryWarned = true;
      }
    }
  }

  /** Monotonic room-level revision counter. Incremented on every successful mutation. */
  private async getRevision(): Promise<number> {
    return (await this.ctx.storage.get<number>('revision')) || 0;
  }

  private async bumpRevision(): Promise<number> {
    const next = (await this.getRevision()) + 1;
    await this.ctx.storage.put('revision', next);
    return next;
  }

  /** The wall-clock of the most recent edit touching this room's elements. */
  private getLastEditAt(): number {
    const row = this.sql.exec('SELECT MAX(updated_at) AS max_ts FROM elements').one();
    return (row?.max_ts as number) || 0;
  }

  // HTTP handler for REST API
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }

    // Lightweight reachability probe for offline detection
    if (url.pathname === '/ping') {
      return Response.json({ ok: true });
    }

    // Full snapshot + metadata for offline reconciliation
    if (url.pathname === '/state' && request.method === 'GET') {
      return this.handleGetState();
    }

    // Offline outbox replay: apply a batch of ops IF the client's base
    // revision still matches. Otherwise return the current state so the
    // client can detect divergence and decide to resync or fork.
    if (url.pathname === '/events' && request.method === 'PUT') {
      return this.handlePutEvents(request);
    }

    if (url.pathname === '/elements') {
      if (request.method === 'GET') {
        return this.handleGetElements();
      }
      if (request.method === 'PUT') {
        return this.handlePutElements(request);
      }
    }

    // Contributor list for this room ("who has edited here") — consumed by
    // tests and by the contribution registry plumbing.
    if (url.pathname === '/contributors' && request.method === 'GET') {
      return this.handleGetContributors();
    }

    return new Response('Not found', { status: 404 });
  }

  private handleGetContributors(): Response {
    const rows = this.sql
      .exec('SELECT user_id, last_seen_at FROM contributors')
      .toArray() as unknown as Array<{ user_id: unknown; last_seen_at: unknown }>;
    return Response.json({
      contributors: rows.map((row) => ({
        userId: row.user_id as string,
        lastSeenAt: (row.last_seen_at as number) || 0,
      })),
    });
  }

  private async handleGetState(): Promise<Response> {
    const elements = this.loadAllElements();
    return Response.json({
      revision: await this.getRevision(),
      lastEditAt: this.getLastEditAt(),
      elements,
    });
  }

  private async handlePutEvents(request: Request): Promise<Response> {
    let body: { ops: any[]; baseRevision: number; userId?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid body' }, { status: 400 });
    }

    const { ops = [], baseRevision = 0, userId } = body;
    const currentRevision = await this.getRevision();

    // Attribution happens before the divergence check: even a replay the room
    // cannot accept (stale baseRevision) proves this user touched the room.
    await this.recordContributor(typeof userId === 'string' && userId ? userId : null);

    // If the client's outbox was built on a stale snapshot, we cannot
    // safely replay it — return the current state for the client to
    // reconcile (resync or fork).
    if (baseRevision !== currentRevision) {
      return Response.json({
        ok: false,
        diverged: true,
        revision: currentRevision,
        lastEditAt: this.getLastEditAt(),
        elements: this.loadAllElements(),
      });
    }

    const upserts: ExcalidrawElement[] = [];
    const deleteIds: string[] = [];

    for (const op of ops) {
      if (op.type === 'element-update') {
        for (const el of op.elements) upserts.push(el);
      } else if (op.type === 'element-delete') {
        for (const id of op.elementIds || []) deleteIds.push(id);
      }
    }

    if (upserts.length > 0) this.persistElements(upserts);
    for (const id of deleteIds) {
      this.sql.exec(
        'UPDATE elements SET is_deleted = 1, updated_at = ? WHERE id = ?',
        Date.now(), id
      );
    }

    const revision = await this.bumpRevision();

    // Broadcast live so any online collaborators see the reconciled state.
    if (upserts.length > 0) {
      this.broadcast({ type: 'element-update', elements: upserts, senderId: 'offline-sync' });
    }
    if (deleteIds.length > 0) {
      this.broadcast({ type: 'element-delete', elementIds: deleteIds, senderId: 'offline-sync' });
    }

    return Response.json({ ok: true, revision, lastEditAt: this.getLastEditAt() });
  }

  private handleWebSocket(request: Request): Response {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || crypto.randomUUID();
    const username = url.searchParams.get('username') || 'Anonymous';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);

    this.sessions.set(server, { userId, username, ws: server });

    // Notify others
    const userCount = this.sessions.size;
    this.broadcast({
      type: 'user-joined',
      userId,
      username,
      userCount,
    }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    const session = this.sessions.get(ws);
    if (!session) return;

    try {
      const msg = JSON.parse(message) as ClientMessage;
      await this.handleClientMessage(ws, session, msg);
    } catch {
      // Invalid message, ignore
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    const session = this.sessions.get(ws);
    if (session) {
      this.sessions.delete(ws);
      this.broadcast({
        type: 'user-left',
        userId: session.userId,
        userCount: this.sessions.size,
      });
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const session = this.sessions.get(ws);
    if (session) {
      this.sessions.delete(ws);
    }
  }

  private async handleClientMessage(ws: WebSocket, session: SessionInfo, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'element-update': {
        const changed = this.persistElements(msg.elements);
        if (changed > 0) this.bumpRevision();
        // Fire-and-forget: registry latency must never sit between persist
        // and broadcast on the live WS hot path.
        void this.recordContributor(session.userId);
        this.broadcast({
          type: 'element-update',
          elements: msg.elements,
          senderId: session.userId,
        }, ws);
        break;
      }

      case 'element-delete': {
        for (const id of msg.elementIds) {
          this.sql.exec(
            'UPDATE elements SET is_deleted = 1, updated_at = ? WHERE id = ?',
            Date.now(), id
          );
        }
        this.bumpRevision();
        // Fire-and-forget on the live WS hot path (same rationale as above).
        void this.recordContributor(session.userId);
        this.broadcast({
          type: 'element-delete',
          elementIds: msg.elementIds,
          senderId: session.userId,
        }, ws);
        break;
      }

      case 'cursor-move':
        this.broadcast({
          type: 'cursor-move',
          userId: session.userId,
          x: msg.x,
          y: msg.y,
          username: session.username,
        }, ws);
        break;

      case 'request-sync': {
        const elements = this.loadAllElements();
        this.sendTo(ws, { type: 'full-sync', elements });
        break;
      }

      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;
    }
  }

  private persistElements(elements: ExcalidrawElement[]): number {
    let changed = 0;
    for (const el of elements) {
      const existing = this.sql.exec(
        'SELECT version FROM elements WHERE id = ?', el.id
      ).toArray();

      if (existing.length > 0) {
        const existingVersion = existing[0].version as number;
        if (el.version >= existingVersion) {
          this.sql.exec(
            'UPDATE elements SET type = ?, data = ?, version = ?, is_deleted = ?, updated_at = ? WHERE id = ?',
            el.type, JSON.stringify(el), el.version, el.isDeleted ? 1 : 0, Date.now(), el.id
          );
          changed++;
        }
      } else {
        this.sql.exec(
          'INSERT INTO elements (id, type, data, version, is_deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          el.id, el.type, JSON.stringify(el), el.version, el.isDeleted ? 1 : 0, Date.now()
        );
        changed++;
      }
    }
    return changed;
  }

  private loadAllElements(): ExcalidrawElement[] {
    const rows = this.sql.exec('SELECT data FROM elements WHERE is_deleted = 0').toArray();
    return rows.map(row => JSON.parse(row.data as string));
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch {
          // Dead socket, will be cleaned up on close
        }
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket dead
    }
  }

  // REST endpoints
  private handleGetElements(): Response {
    const elements = this.loadAllElements();
    return Response.json(elements);
  }

  private async handlePutElements(request: Request): Promise<Response> {
    const elements = await request.json() as ExcalidrawElement[];
    this.persistElements(elements);
    // Fire-and-forget: don't block the (broadcasting) response on the registry.
    void this.recordContributor(request.headers.get('X-User-Id'));
    this.broadcast({
      type: 'element-update',
      elements,
      senderId: 'api',
    });
    return Response.json({ ok: true });
  }
}
