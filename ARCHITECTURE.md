# Architecture — this app's Durable Object persistence model

## What a Durable Object persistence model is

A Durable Object runs in Cloudflare's **V8 isolate**. Crucially, the isolate (the in-memory JavaScript environment) is **not** permanent — Cloudflare can evict it at any time (inactivity, migrations, system reclaim). That means anything held **purely in memory** is *lost* when the isolate is evicted. Two things survive eviction:

1. **Transactional key-value storage** — via `this.ctx.storage` (or the newer `ctx.storage.sql` for SQLite).
2. **In-flight WebSocket connections**, plus the durable WebSocket session state associated with them.

The design principle is: **memory is a cache, durable storage is the truth.** Code should rehydrate from storage whenever it needs state.

## What THIS app's `DrawingRoom` actually persists (evidence from the code)

Tracing through `src/do/drawing-room.ts`:

| Data | Where it lives | Persisted? | Guarantee |
|------|---------------|-----------|-----------|
| **Drawing elements** (shapes, lines, text) | SQLite table `elements` via `this.sql` (`ctx.storage.sql`) | ✅ **Yes** | Survives isolate eviction; durable and transactional |
| **Deletion flags** | `UPDATE elements SET is_deleted = 1` | ✅ **Yes** | Same SQLite table, durable |
| **Versions** (conflict detection) | `version` column + `updated_at` | ✅ **Yes** | Written transactionally with each update |
| **Connected sessions / user info** | `private sessions: Map<WebSocket, SessionInfo>` | ❌ **No** | In-memory only — rebuilt from live WebSocket connections |

So the **guarantee is: all canvas *content* is durable — the live *presence* of users is not.**

## The concrete guarantees this app offers

**Canvas data survives restarts and evictions.** Every `element-update` message writes rows to SQLite (`persistElements`), and deletes flip `is_deleted`. If the isolate is evicted mid-session, a new instance boots, re-runs the `CREATE TABLE IF NOT EXISTS` migration in the constructor, and the data is still there. A returning client calls `request-sync` → `loadAllElements()` → `full-sync` and receives the entire canvas back.

**No data-loss window on writes.** Each `this.sql.exec(...)` is a single SQLite transaction, so a given element write is either fully committed or not at all — no torn half-writes.

**Live sessions are *not* durable** — but that's by design and acceptable. `sessions` is a `Map` of open WebSockets. If the isolate evicts, those sockets close; when users reconnect and send `request-sync`, the durable SQLite state restores the *content*. Presence (cursor positions, who's online) is ephemeral, which is fine for this use case — nobody's drawing is lost, only their momentary "online" status.

## One nuance worth flagging to the principal engineer

There's a subtle durability caveat. `handleClientMessage` receives a client-provided list of elements on `element-update`. Look at the **optimistic write**:

```ts
private persistElements(elements: ExcalidrawElement[]): void {
  const existing = this.sql.exec('SELECT version FROM elements WHERE id = ?', el.id).toArray();
  if (existing.length > 0 && el.version >= existingVersion) {
     // UPDATE ...
  } else {
     // INSERT ...
  }
}
```

Because `persistElements` writes the *entire* `data` payload JSON verbatim:

```ts
this.sql.exec('UPDATE elements SET ..., data = ?, ...', ..., JSON.stringify(el), ...)
```

This writes whichever element object the client sent — **including transient/in-flight edits a user is still mid-gesture on**. Since WebSocket messages aren't transactional/durable until the `sql.exec` returns, a user's incomplete drag that got persisted will be replayed to everyone on the next `full-sync`. That's a real, if minor, fidelity concern: you're persisting *every keystroke/move*, not just "committed" shapes. In a real-time collab app you often want a debounce or a "commit vs preview" split so half-finished strokes don't become the canonical durable state.

## Bottom line

- **Durable:** all drawing content, in SQLite, transactionally. Survives V8 isolate eviction.
- **Not durable:** live session/presence state (in memory only) — acceptable, since content fully rehydrates from SQLite on reconnect.
- **V8-isolate detail to remember:** never rely on class fields (`this.sessions`, `this.cursorPositions`, etc.) for anything that must survive eviction — put it in `ctx.storage`. This app follows that rule for the content, and only "cheats" on ephemeral presence, which is correct.
