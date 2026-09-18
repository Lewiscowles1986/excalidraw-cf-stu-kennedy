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

This demo collects **no PII about its users** — there is no auth, no signup, and nothing ties any identifier to a real-world person. Room URLs are capabilities. That said, one identifier *is* persistent by design, so the honest framing is **pseudonymous, not anonymous**.

### The identifiers — pseudonymous, not anonymous

| Identifier | Value | Source | PII? |
|-----------|-------|--------|------|
| `userId` | `crypto.randomUUID()`, minted **once per device** | Persisted in `localStorage` under `excalidraw-cf:userId` (`client/identity.ts`) | ⚠️ — a persistent pseudonymous device identifier; no link to a person |
| `username` | `User ${random 0-999}` | Auto-generated (`client/ws-client.ts`) | ❌ — anonymous generic label |
| `roomId` | 8-char random UUID, or a typed room ID | `routes/drawing.tsx` `/new` | ❌ — a room *address*, not a person |

Key facts about `userId`:

- **Usernames can never be a real name.** A `setUsername()` method exists in `client/ws-client.ts`, but it is **never called** anywhere in the codebase — no UI, form, or event wires it up. The cursor label collaborators see is always "User 42"-style.
- **No email / real name / phone / address / IP / free-text "display name" input exists.** The only form input in `views/drawing-page.tsx` is the room-ID join box (a room address, not a person).
- **It is stable, not per-tab.** `client/identity.ts` mints a UUID on first load and re-uses it on every later visit from the same browser profile — that persistence is precisely what lets "rooms you've edited" accumulate over time.
- **It IS stored server-side.** Every attributed edit writes it to two SQLite tables: the room-local `contributors` table (`do/drawing-room.ts`, user_id + last_seen_at) and the per-user `room_contributions` table in the `RoomRegistry` Durable Object (`do/room-registry.ts`, user_id + room_id + last_edit_at). This powers the `GET /api/rooms?userId=…` "rooms you've edited" listing.
- **It is not linked to any real-world identity and is never shared with third parties** (no auth exists, and the id travels only between the browser and this app's own Durable Objects) — but plainly: **it is a persistent device identifier** used to attribute edits, so it should be treated as pseudonymous data under most privacy regimes, not as "no data".

### What is persisted (the durable layer)

The SQLite `elements` table holds **drawing geometry/shape properties** — coordinates, colors, stroke widths, and any *text the user types into a shape*. On top of that, the attribution writes persist `userId` in the two SQLite tables described above (`contributors` in each DrawingRoom, `room_contributions` in the per-user RoomRegistry). The live `sessions` Map holding `userId`/`username` per open WebSocket is still **in-memory only** — but unlike presence, the attribution rows are durable by design: they must survive eviction for the registry to work.

### Tracking posture: no third-party tracking, one first-party persistent id

- No cookies (`document.cookie` — zero usages).
- No analytics / telemetry / third-party trackers (nothing in `package.json`).
- No server-side IP or request logging.
- The one persistent identifier is the first-party `userId` above: the app stores a persistent pseudonymous device id (browser `localStorage` + server-side SQLite attribution rows) solely for edit attribution — nothing else is tracked, and nothing is shared externally.
- Other `localStorage` usage (`client/state.ts`) stores **UI style preferences** (stroke color, width, etc.) on the user's own browser — not sent to the server, not personal data.

### Data-hygiene notes for reviewers

1. **Deletes are soft-deletes, not purges.** Deleting a shape only flips `is_deleted = 1` (`do/drawing-room.ts`); the full element JSON stays in SQLite indefinitely. Fine for a demo — but there is **no TTL and no purge path** (see the "expiring rooms" topic above). If this ever holds real users' work, retention needs a cleanup story.
2. **PII could arrive as user-authored content, not collected data.** It's a drawing app, so someone could type "John: (555) 123-4567" as a text shape. That's user-authored content on a shared canvas, not the app *collecting* PII — but any privacy policy / deletion guarantee would need to focus on canvas text, not the identity system.

**Bottom line:** the app collects no PII *about* users — no auth, no profile, no third parties, no cookie layer. It does persist a stable pseudonymous device id (`userId`) in `localStorage` and server-side SQLite purely for edit attribution; there is no way to link it to a person, but it is a persistent record of that device's edits across visits, and reviewers should weigh it as pseudonymous data rather than "nothing".

---

## Offline-first architecture

The app is **local-first**: the browser is the source of truth while the backend is unreachable, and it reconciles with the server once connectivity returns.

### Why "local-first" instead of "cache the server"

Ordinary caching mirrors server state so you can *read* offline. Local-first goes further: you can also **write** offline, queueing those writes, then reconcile on reconnection. This keeps a shared canvas usable on a plane, train, or during a Cloudflare outage — and it's what enables turn-based play (e.g. a chess app where two players on separate offline copies take turns that later merge).

### The pieces

1. **Connectivity detection (`client/offline/connectivity.ts`)** treats **`navigator.onLine` as the trusted source of truth**: the app flips online/offline only when the browser's `online`/`offline` events fire. There is deliberately **no ping probe** — a single failed `/api/ping` is not evidence of a dead network, so the app must not flip to offline on request failures.
2. **IndexedDB store (`client/offline/database.ts`)** keeps a per-room snapshot (`OfflineRoom`) plus an append-only **event log** (the outbox). A service worker (`public/sw.js`) precaches static assets so the app shell itself boots offline.
3. **Outbox (`client/ws-client.ts`)** — every user mutation is appended to IndexedDB *before* any socket/HTTP send. The legacy `flushAll`/`saveViaHttp` paths are gated on connectivity so offline edits are never dropped.
4. **Sync engine (`client/offline/sync.ts`)** replays the outbox to the server on reconnect via `PUT /api/rooms/:roomId/events`, sending its **base revision** so the server can detect divergence:
   - **revision matches** → ops apply cleanly (`synced`), outbox drains, room marked clean.
   - **no local edits since offline** → simply adopt the server snapshot (fast-forward).
   - **both sides moved** → the server returns `diverged` with current state; the client offers to **fork** into a new room and replays the local event log there, *avoiding merge conflicts by never merging*.
5. **Server (`do/drawing-room.ts`)** maintains a monotonic `revision` (via `ctx.storage`) bumped on every successful mutation (WebSocket + API + offline replay). `/state` returns revision + elements; `/events` applies a batch only when the client base still matches.
6. **UI (`client/offline/offline-ui.ts`)** — a banner shows offline/pending state; a modal offers "Fork into new room" vs "Keep working offline" when divergence is detected.

### Design notes / honest trade-offs

- **No merge conflict resolution yet.** Forking is the *only* divergent strategy implemented. That is intentional and documented as out of scope: later strategies (field-level merge, LWW by timestamp) can plug into `handleDivergence`.
- **`/events` replays the whole outbox as one batch.** For long offline sessions this grows; a later refinement could send a compaction (latest snapshot) instead of thousands of ops.
- **Optimistic persistence caveat (from above) still applies:** the outbox records every in-flight edit, so incomplete gestures are persisted. Same fidelity concern as the live path.
- **`OfflineOp` derives from `MutationMessage`** (`types/protocol.ts`) so the offline log can never drift from the live socket protocol.
- **Testing:** Playwright tests in `tests/interactions.spec.ts` cover landing, draw-and-persist, offline banner, and offline queue→drain-on-reconnect using `context.setOffline`.

