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

---

## Privacy & PII posture

This demo collects **no PII about its users**. Every user-facing identifier is randomly generated and anonymous; the only data persisted is drawing content.

### The identifiers — and why none are PII

| Identifier | Value | Source | PII? |
|-----------|-------|--------|------|
| `userId` | `crypto.randomUUID()` | Random per browser session (`client/ws-client.ts`) | ❌ — random, no link to a person |
| `username` | `User ${random 0-999}` | Auto-generated (`client/ws-client.ts`) | ❌ — anonymous generic label |
| `roomId` | 8-char random UUID, or a typed room ID | `routes/drawing.tsx` `/new` | ❌ — a room *address*, not a person |

Key facts confirming no PII:

- **Usernames can never be a real name.** A `setUsername()` method exists in `client/ws-client.ts`, but it is **never called** anywhere in the codebase — no UI, form, or event wires it up. The cursor label collaborators see is always "User 42"-style.
- **No email / real name / phone / address / IP / free-text "display name" input exists.** The only form input in `views/drawing-page.tsx` is the room-ID join box (a room address, not a person).
- **`userId` is a fresh UUID per tab** — regenerated on load, so it is not even a persistent tracker across visits.

### What is persisted (the durable layer)

The only writes to the SQLite `elements` table are **drawing geometry/shape properties** — coordinates, colors, stroke widths, and any *text the user author types into a shape*. The `sessions` Map holding `userId`/`username` is **in-memory only and never written to SQLite**, so anonymous identity dies with the WebSocket connection.

### No tracking of any kind

- No cookies (`document.cookie` — zero usages).
- No analytics / telemetry / third-party trackers (nothing in `package.json`).
- No server-side IP or request logging.
- Only `localStorage` usage (`client/state.ts`) stores **UI style preferences** (stroke color, width, etc.) on the user's own browser — not sent to the server, not personal data.

### Data-hygiene notes for reviewers

1. **Deletes are soft-deletes, not purges.** Deleting a shape only flips `is_deleted = 1` (`do/drawing-room.ts`); the full element JSON stays in SQLite indefinitely. Fine for a demo — but there is **no TTL and no purge path** (see the "expiring rooms" topic above). If this ever holds real users' work, retention needs a cleanup story.
2. **PII could arrive as user-authored content, not collected data.** It's a drawing app, so someone could type "John: (555) 123-4567" as a text shape. That's user-authored content on a shared canvas, not the app *collecting* PII — but any privacy policy / deletion guarantee would need to focus on canvas text, not the identity system.

**Bottom line:** the app collects zero PII about users. The only held data is anonymous drawing content; user-supplied personal identifiers are impossible; and there is no tracking or cookie layer.
