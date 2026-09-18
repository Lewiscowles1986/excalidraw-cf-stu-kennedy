# Reusability — extracting the collaboration layer

> **Audience:** builders of *other* client-side apps (whiteboards, turn-based
> games, shared cursors, live quizzes) who want multiplayer without writing a
> backend per app.
>
> **Companion doc:** [experiments.md](./experiments.md) — the sans-internet,
> browser-to-browser proposal (Web Bluetooth and friends).

---

## 1. Why this document exists

This repo started as "an Excalidraw clone" and quietly became something more
interesting: a **generic real-time collaboration substrate**. Nothing in the
server is drawing-specific. Strip away the canvas and what remains is a
reusable pattern:

- a **room** with a durable, transactional state record (SQLite inside a
  Durable Object),
- a **live fan-out transport** (WebSockets) that broadcasts every mutation to
  everyone present,
- a **client-authoritative write path** — the browser owns its own edits and
  ships them as ops,
- an **offline outbox** that replays queued ops with a revision check on
  reconnect, and **forks rather than merges** when the two sides diverge.

Any app whose state can be expressed as a **set of addressable objects that
clients mutate** can reuse this nearly verbatim. That covers a surprising
amount: whiteboards, task boards, turn-based games (chess, tic-tac-toe),
presence systems, and — with the caveats in §8 — many casual games.

The lessons here are about *boundaries*, not just code: knowing which parts of
this repo are the substrate (copy them) and which are the canvas (leave them
behind).

---

## 2. The separation test: is your app even a fit?

Before extracting anything, apply this filter. A room-state collaboration
backend fits when **most of these are true**:

| # | Heuristic | Why it matters |
|---|-----------|----------------|
| 1 | State decomposes into **discrete entities with stable IDs** (pieces, cards, strokes, units) | The server stores rows by id; ops address entities by id |
| 2 | Mutations are **op-shaped**: create/update/delete of a few entities | This is exactly the `MutationMessage` shape; whole-state diffs would need a different protocol |
| 3 | **Last-writer-wins per entity is acceptable** | The server resolves conflicts per-entity by version; there is no field-level merge or CRDT |
| 4 | **Turn structure is lenient** — you tolerate rare double-moves | Enforced turns need server-side validation hooks (§7); the stock room trusts clients |
| 5 | **Fork-not-merge is an acceptable divergence policy** | This is the implemented strategy; CRDTs are the alternative if you need automatic merge |
| 6 | **Ephemeral presence can evaporate** | Cursors/presence live in memory only and vanish on eviction — by design |

Two examples of the boundary:

- **Chess fits.** A move is "update the entity with id `e2e4-piece-qb`" plus a
  `turnIndex` bump — discrete, op-shaped, and a rare offline double-move
  between two players is recoverable by social convention ("whoops, take it
  back").
- **A physics game does not fit (stock).** Ticks at 60fps against a shared
  authoritative server would need prediction/rollback — a different class of
  system. See §8 for what *can* be salvaged.

---

## 3. What actually lives in each file (the extraction map)

This is the honest inventory: what ports as-is, what needs renaming, what is
app-specific and stays behind.

### Tier 1 — the reusable substrate (copy or re-home)

| Piece | Where it lives here | Ports as-is? | Notes for extraction |
|---|---|---|---|
| **Durable Object room skeleton** | `src/do/drawing-room.ts` | ✅ Rename `DrawingRoom` → `Room` | The `fetch()` router, WS lifecycle (`webSocketMessage/Close/Error`), and `broadcast()` are generic. Generic-ify the table schema (§5) |
| **SQLite persistence pattern** | `persistElements`, `loadAllElements` | ✅ | The `id / data / version / is_deleted / updated_at` row shape is the reusable part — see §5 |
| **Monotonic revision counter** | `getRevision` / `bumpRevision` via `ctx.storage` | ✅ | THE conflict-detection primitive for offline replay. Tiny code, huge payoff |
| **WS protocol envelope** | `src/types/protocol.ts` | ✅ | Rename the payload types; the *shape* (mutation vs presence vs sync) is the reusable design |
| **Offline op type derivation** | `OfflineOp = MutationMessage` | ✅ | The key trick: derive the outbox op from the live protocol so the two **cannot drift**. Keep this coupling in any port |
| **Connectivity monitor** | `src/client/offline/connectivity.ts` | ✅ | Pessimistic-by-default ("offline until proven online") is the transferable idea. Note: repo memory records a design debate — see the caveat below |
| **IndexedDB outbox + room snapshot** | `src/client/offline/database.ts` | ✅ | Generic two-store shape: `rooms` (snapshot) + `events` (append-only op log) |
| **Sync engine** | `src/client/offline/sync.ts` | ✅ | Replay-on-reconnect, revision check, benign-drain, fork-offer. ~200 lines, app-agnostic |
| **Divergence UX (fork modal)** | `offline-ui.ts` + `handleDivergence` | ⚠️ | Strategy is generic, copy is app-specific. Re-home behind an interface |
| **Reconnect policy** | `ws-client.ts` | ⚠️ | Exponential backoff + attempts cap is generic; *when* to retry is entangled with connectivity policy (caveat below) |

> **Caveat on connectivity:** repo memory records a design decision that
> `navigator.onLine` should be the trusted signal and a ping-probe heuristic is
> "poor design" for deciding *app* connectivity. The checked-in code still uses
> ping-probes. If you extract `connectivity.ts`, extract the **principle**
> (pessimistic default, cheap periodic probe) and re-litigate the mechanism for
> your app — a single failed probe should not flip you offline.

### Tier 2 — thin, mostly-generic wiring (small rewrites)

| Piece | Where it lives here | Notes |
|---|---|---|
| HTTP API surface | `src/routes/api.tsx` | `/ping`, `/state`, `/events` (PUT with `baseRevision`), `/elements`. The routes are generic; the Hono↔DO `stub.fetch` plumbing is Cloudflare-specific but tiny |
| WS upgrade route | `src/index.tsx` `/ws/:roomId` | 5 lines; forwards the upgrade to the DO |
| Fork room flow | `sync.ts` `forkRoom` | "Copy local log into a new room id" is generic; the *room id minting* is app-specific |
| Sync status events | `CustomEvent`s from `sync.ts` / `connectivity.ts` | Rename the `excalidraw:*` prefixes; keep the event-driven (framework-free) shape |

### Tier 3 — app-specific, leave behind

| Piece | Why it stays |
|---|---|
| `src/client/*` canvas engine (renderer, interaction, hit-test, geometry, z-order, history, selection…) | This *is* the app. The substrate never needs to know a canvas exists |
| `ExcalidrawElement` types | Your domain objects replace these. The *row contract* in §5 is all the server needs |
| `src/views/*` UI, `bridge.ts`, `sse.tsx` (Datastar) | App's presentation & SSR wiring. The SSE routes here are **UI-state fan-out**, not room collaboration — do not confuse them |
| Element factory, icons, color picker, export/import | Canvas features |
| `public/sw.js` asset precaching | Reusable in *principle* (offline app shell), but the cache manifest is app-specific |

The litmus test from §2 is also the boundary test: **anything that knows about
"elements" by name is app-specific; anything that only knows about "ops,
revisions, sessions, and rows" is substrate.**

---

## 4. The target architecture for a reusable package

```
your-collab-kit/
├── server/                     # Cloudflare-side (the "room service")
│   ├── room.ts                 # Durable Object: WS + /state + /events + /ping
│   ├── schema.ts               # SQLite DDL: rows keyed by (room, entity id)
│   └── index.ts                # Hono (or bare Worker) mounting + WS upgrade
├── client/
│   ├── room-socket.ts          # connect/reconnect/apply-remote/send-op
│   ├── transport.ts            # Transport interface: WebSocket | SSE+POST | custom
│   ├── offline/
│   │   ├── store.ts            # IndexedDB: snapshot + outbox (2 stores)
│   │   ├── sync.ts             # replay + revision check + fork
│   │   └── connectivity.ts     # pessimistic online/offline signal
│   └── types.ts                # protocol envelope, op types
└── package.json
```

Consumer apps then write only three things:

1. **A row mapper** — `(entity) → row` and `(row) → entity`, so the server never
   learns your domain types.
2. **Op producers** — app events → `MutationMessage`s (e.g. chess: "move" →
   `entity-update` on two piece entities + turn entity).
3. **Op appliers** — remote ops → app state updates (the mirror of #2).

### The `Transport` seam

The protocol is transport-agnostic — messages are JSON envelopes. The DO's
`fetch()` already handles `/ws`, `/ping`, `/state`, `/events` over HTTP, which
means an **SSE+POST transport is nearly free**: subscribe to an SSE stream for
`ServerMessage`s, POST `ClientMessage`s to an endpoint that forwards to the DO.
That keeps the kit usable where WebSockets are awkward (some proxies, some SSR
runtimes) and is how the repo's Datastar/SSE routes demonstrate the pattern's
transport independence. Keep the seam: `send(msg)` / `onMessage(cb)` is the
entire interface the rest of the client needs.

---

## 5. The persistence contract (what to keep stable)

This is the single most valuable thing to get right in an extraction, because
everything else (replay, divergence, broadcast) hangs off it.

**Row shape** (one row per entity, per room):

| Column | Purpose | Reuse note |
|---|---|---|
| `id` (PK) | Stable entity id, client-minted (`crypto.randomUUID()`) | Client-minted ids are what let offline creates replay without collision. Prefer UUIDv7 over v4 — see "Ordering" below |
| `data` | Full entity JSON, written verbatim | Simple + sufficient **for LWW-per-entity**. If you later need field merge, this is the seam you widen |
| `version` | Client-provided monotonic int per entity | The conflict arbiter: `UPDATE ... WHERE version >= existing` |
| `is_deleted` | Soft-delete flag | Tombstones are load-bearing for offline replay (a delete op must survive even if the create arrives later). Add a purge/TTL path before real users |
| `updated_at` | Server wall clock | Powers "last edit" reporting |

Plus **one room-level revision counter** in KV storage (`ctx.storage`), bumped
transactionally-ish on every accepted mutation batch. `PUT /events` compares the
client's `baseRevision` to the room's current revision *before applying*:

- **match** → apply ops, bump revision, broadcast → `synced`
- **mismatch** → return current state → client decides (adopt or fork)

This is the whole conflict story. It is deliberately crude — **compare-then-
apply instead of merge** — and that crudeness is why it's portable. The
alternatives (field-level merge, CRDTs) buy fewer forks at the cost of an
entirely different server implementation; the fork policy is the honest
starting point this repo proved out.

### Ordering: revision, clock, and UUIDv7

Three ordering jobs hide in this design, and it pays to keep them separate:

| Job | What answers it today |
|---|---|
| **Room sequence** — the authority's total order of accepted mutations | The monotonic `revision` counter |
| **Event identity** — a globally unique name per edit | Nothing dedicated (entity ids are random v4 UUIDs, order-free) |
| **Cross-editor tie-break** — two editors write at the same moment; who wins? | Arrival order at the server (LWW by accident of latency) |

A tempting fourth answer is "give the revision a clock and let wall time be
the order." It fails exactly where it's needed: two editors make one edit each
in the same millisecond → identical timestamps → collision; and device clock
skew scrambles the order even when timestamps differ. A pure clock is a
*partial* order wearing a *total* order's clothes. (The general fix pattern is
a **Hybrid Logical Clock** — wall time plus a logical counter; UUIDv7 is its
identifier-shaped cousin.)

**UUIDv7 (RFC 9562) is a 48-bit millisecond timestamp followed by ~74 bits of
randomness** (optionally a per-node monotonic counter, so same-millisecond ids
from one process never go backwards). Three consequences:

- Same-millisecond edits from different editors still get **distinct ids** —
  the random suffix breaks the tie the clock alone cannot.
- Lexicographic sort ≈ chronological order (k-sortable): ids carry time order
  for free — creation-order z-sorting, "when was this born?" debugging,
  stable event sorts.
- **No coordination:** two offline editors mint ids that merge cleanly later —
  roughly time-ordered, zero collisions.

Be precise about what it buys and what it doesn't:

- ✅ **Tie-break collision solved.** "Highest UUIDv7 wins" is a deterministic,
  effectively tie-free total order for LWW — no longer shaped by network luck.
- ❌ **Semantic conflict not solved.** If both editors changed the same field,
  v7 still just picks a winner; the loser's intent dies. It remains LWW —
  fair dice instead of a race.
- ❌ **Room sequence not replaced.** Id order is only as good as the clocks;
  skew keeps chronology approximate. `revision` stays the authority for
  `baseRevision` checks — v7 is per-event identity, not room truth.

Cheap adoption path: mint entity ids as UUIDv7 instead of v4 today (no
behavior risk; ids become k-sortable), and reach for clock-ordered
tie-breaking only once two authorities exist — fork merges, local play (see
[experiments.md](./experiments.md)). The single-authority stock room never
needs it.

**Soft-deletes deserve emphasis:** because the outbox is append-only and can
hold `create` → `delete` in sequence, the server must keep tombstones or a
replayed `delete` for a never-seen id becomes a no-op and the resurrected
entity ghosts every collaborator. If your app purges rows eagerly, offline
replay semantics break in ways that are painful to debug.

---

## 6. The protocol envelope (what to keep stable, part 2)

`src/types/protocol.ts` is small, and that is the point. The reusable design has
exactly four message classes:

```ts
// 1. Mutations (client → server). The outbox log stores exactly these.
type Mutation =
  | { type: 'entity-update'; entities: Entity[] }
  | { type: 'entity-delete'; entityIds: string[] };

// 2. Presence (client → server, ephemeral, never persisted)
type Presence = { type: 'presence'; ... };

// 3. Sync (client → server, stateless request)
type SyncReq = { type: 'request-sync' };

// 4. Server → client fan-out
type ServerMessage =
  | { type: 'entity-update'; entities: Entity[]; senderId: string }
  | { type: 'entity-delete'; entityIds: string[]; senderId: string }
  | { type: 'presence'; userId: string; ... }
  | { type: 'full-sync'; entities: Entity[] }
  | { type: 'user-joined' | 'user-left'; ... };
```

Three design rules worth copying:

1. **`senderId` on every fan-out.** The client filters its own echoes —
   because it applied the op locally already. This is what makes the
   write-path "apply locally, ship op" work without echo loops.
2. **Derive the outbox op type from the mutation type** (`OfflineOp =
   MutationMessage`). If you redefine the protocol, the offline log redefines
   with it. This coupling is what prevented protocol drift in this repo.
3. **Presence is a separate message class, never persisted.** Presence dies
   with the connection; content survives eviction. Keeping them in distinct
   classes makes the durability boundary explicit in the types themselves.

The server-side rule that makes it all safe: **the room never invents state.**
It persists exactly what a client sent (`element-update` → upsert row), and its
only opinions are the revision check and tombstone handling. That
client-authoritative posture is why the offline outbox can replay unchanged:
offline ops *are* live ops.

---

## 7. Adding server-side validation (for turn-based games)

The stock room trusts clients entirely. For chess/turn-based play you will
usually want *some* server opinions. The extraction point is clean: a
**validation hook inside `handleClientMessage`** before `persistElements`:

```ts
case 'entity-update': {
  if (!this.policy.allows(session, msg)) {
    this.sendTo(ws, { type: 'rejected', reason: 'not-your-turn' });
    break; // do not persist, do not broadcast
  }
  // ...persist + broadcast as before
}
```

A `turnIndex` row (or KV key) in the room gives the policy its clock: reject
updates whose `turn !== turnIndex`, bump on move. Because the *offline replay
path* (`PUT /events`) funnels through the same persistence calls, one policy
object gates both live and offline writes — no second implementation to keep
honest.

Keep validation **stateless with respect to the live sessions map** where you
can: sessions evaporate on eviction (see §8), so anything the policy needs
long-term (turn order, player registration) belongs in SQLite, not memory.

---

## 8. What this substrate will NOT give you (honest limits)

Borrowers deserve the failure modes up front:

- **Memory is a cache, storage is the truth.** The `sessions` Map, presence
  table, and cursor positions evaporate on isolate eviction — by design. If
  your game needs durable *presence* (player slots that must survive restarts),
  persist it explicitly. Anything in a class field will betray you.
- **LWW-per-entity, not CRDT.** Concurrent edits to the *same* entity resolve
  by version number; concurrent edits to *different* entities never conflict at
  all. If you need field-level merge, widen the `data` seam (§5) — but that is
  a different project. And if the tie-break should be deterministic rather
  than latency-shaped, see "Ordering: revision, clock, and UUIDv7" in §5.
- **Fork-not-merge on divergence** is the implemented policy. It is safe and
  lossless but socially awkward for two players (who "owns" the forked room?).
  For a 2-player game, prefer fast-forward-if-clean + explicit takeover.
- **No server tick loop.** The room is event-driven; it does nothing until a
  client speaks. Real-time action games need a ticking authority (or a
  client-driven tick op) and prediction/rollback — different literature.
- **Broadcast only reaches live sessions.** Nothing is queued for absent users;
  their `request-sync` on reconnect is the catch-up mechanism. Fine for
  whiteboards and turns; wrong for "must-not-miss" events (use
  notifications/queues for that).
- **Optimistic persistence caveat** (documented in ARCHITECTURE.md): in-flight
  gestures get persisted verbatim mid-drag. For a game this means partial moves
  can become canonical if you don't debounce/commit explicitly. Budget for a
  commit-vs-preview distinction in the protocol if fidelity matters.
- **No auth in the box.** Anyone with a room URL is in the room. The seam for
  auth is the WS upgrade + `/events` endpoints; add it before strangers matter.
- **Retention:** soft-deletes accumulate; there is no TTL or purge. Fine for a
  demo, unacceptable for production storage of user content.

---

## 9. Gaming: three integration depths

The same kit supports three tiers of game integration, cheapest first:

### Tier A — turn-based, client-authoritative (nearly free)
Chess, checkers, tic-tac-toe, word games, party-game state machines. State =
entities; moves = ops; turn enforcement = §7's validation hook. Offline play
comes *free* from the outbox (both players can play on a plane and fork/replay
on reconnect). This is the sweet spot for this substrate.

### Tier B — shared world, low-frequency updates
A shared map, a co-op inventory, a collaborative story. Same architecture; add
the validation hook and maybe presence persistence. Still no tick loop. Offline
edits may conflict more often as entity counts grow — the fork policy gets
exercise.

### Tier C — real-time action (partial reuse only)
Take the room + presence + durable snapshot, but replace the op protocol with a
tick/authority model. Reuse: DO-per-room fan-out, SQLite snapshots, presence.
Replace: everything about the write path. Do not ship this tier on the stock
substrate; budget for a real netcode design.

### A worked sketch (Tier A): shared chessboard

Entities: `piece:{squareId}` rows + one `board` row holding `turnIndex`,
`moveNumber`, `result`. White's move is one `entity-update` op covering the
moved piece, the captured piece (or its tombstone), and the `board` row. The
server policy (§7) rejects any op whose `turnIndex` isn't current. Two players
offline each accumulate an outbox; on reconnect, first-to-sync wins the
revision check, the other forks. For casual play, "fork" can be softened to
"adopt server state" — losing the offline moves beats forking a chessboard.

> **Diagram placeholder:** message-flow diagram for the offline replay +
> divergence/fork path. Drop into `docs/reusability/collaboration/assets/` and
> reference from here. A Mermaid draft lives in
> [experiments.md → Appendix](./experiments.md#appendix-diagram-drafts).

---

## 10. Extraction paths, cheapest first

1. **Copy-by-hand (this week):** lift `sync.ts`, `database.ts`,
   `connectivity.ts`, and the DO skeleton into your app; rename; keep the op
   derivation rule. No packaging, no ceremony. Best for proving fit.
2. **`collab-kit` package (the goal):** the §4 layout as a private npm package;
   consumers provide row mappers + op adapters. The repo's own client becomes
   the kit's first consumer — which is also the regression test.
3. **Server-agnostic fork:** if Cloudflare is off the table, the DO contracts
   (§5 revision counter + `/events` with `baseRevision`) port to any single-
   writer-per-room backend: Postgres advisory locks + LISTEN/NOTIFY, Redis pub/
   sub + a lock row, or a plain Node process per room. The *contracts* are the
   portable asset; the DO is one implementation of them.

---

## 11. Testing the extraction

The repo's Playwright offline tests (`tests/interactions.spec.ts`) are the
template for proving a port works:

1. **Load → edit → reload:** content survives via the server snapshot.
2. **Go offline (`context.setOffline`), edit, restore:** edits queue in the
   outbox, banner shows pending state.
3. **Reconnect:** outbox drains via `PUT /events`, revision advances.
4. **Divergence:** two contexts edit offline; the second to sync must detect
   `diverged` and offer fork — assert the fork produces a new room id and the
   old log replays there.
5. **Presence:** two pages, cursor events cross the sockets, no echo of your
   own cursor.

If your extracted kit passes those five, the collaboration layer is real.

---

## 12. Where to look in this repo (quick index)

| Concept | File |
|---|---|
| Room DO (WS + SQLite + revision) | `src/do/drawing-room.ts` |
| Protocol envelope | `src/types/protocol.ts` |
| HTTP API (state/events/ping) | `src/routes/api.tsx` |
| WS upgrade | `src/index.tsx` |
| Client write path (enqueue-then-send) | `src/client/ws-client.ts` |
| Outbox + snapshot store | `src/client/offline/database.ts` |
| Sync engine + fork | `src/client/offline/sync.ts` |
| Connectivity (pessimistic) | `src/client/offline/connectivity.ts` |
| Divergence UX | `src/client/offline/offline-ui.ts` |
| Architecture deep-dive | `ARCHITECTURE.md` |
| Concept stories (8 docs) | `docs/concepts/` |

---

## 13. TL;DR

- The server side is already generic: **rooms, ops, revisions, fan-out,
  tombstoned rows.** Nothing in `drawing-room.ts` knows it's a whiteboard.
- Keep three contracts stable and everything else is swappable: the **row
  schema** (§5), the **protocol envelope** (§6), and the **op = offline log
  entry** derivation.
- The write path is one sentence: **apply locally, enqueue always, send when
  connected, replay with a revision check, fork when in doubt.**
- It fits turn-based games out of the box (add a validation hook for turns);
  it fits shared-state apps as-is; real-time action games need different
  netcode but can still reuse the room/fan-out/persistence bones.
- The sans-internet, browser-to-browser variant (Web Bluetooth) is a separate
  proposal — see [experiments.md](./experiments.md).