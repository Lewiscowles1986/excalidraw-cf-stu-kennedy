# 8. What does "offline-first" mean?

## The problem it solves

The whole app so far — Worker, Hono, SSR, Durable Object, SQLite, WebSockets —
assumes you're **online** and talking to the server. But life isn't that tidy.
You might be on a plane, on a train, or the internet might just drop. What
happens to your drawing then?

Two bad options:

- **Make the app stop working** — you load a blank page and can't draw. Awful.
- **Make the browser the source of truth while offline** — you keep drawing
  perfectly fine on your device, saving the work *locally*, and when the
  internet returns, the app sends that work to the server.

"Offline-first" (a.k.a. **local-first**) is the second, better philosophy: **the
app treats your device as the trusted place to edit, and the network as something
you reconcile with when it's available.** It's the difference between asking
permission from a far-away office versus doing your work now and filing it later.

## The three things it takes

**1. Keep working with no internet.** The app is stored on your device (a service
worker pre-caches the page and the canvas code) and your drawing is saved into a
little database *inside your browser* (**IndexedDB** — think "a mini SQLite that
lives in your browser"). You draw, it saves locally, no server needed.

**2. Remember what you did while offline.** Every change you make while offline is
queued up in a "to-do list" (the **outbox**). Nothing is lost — it's all waiting
in the queue.

**3. Sync when the internet comes back.** The moment you're online again, the app
sends that queued list of changes to the server. The server applies them, and your
online collaborators see them.

### Where in the code?

- `src/client/offline/` — a whole folder of client-side logic:
  - `connectivity.ts` — the app's "am I online?" check (it trusts the
    browser: `navigator.onLine` and the `online`/`offline` events decide).
  - `database.ts` — the in-browser storage (IndexedDB) + the queued outbox.
  - `sync.ts` — the "sync now that I'm back" engine.
  - `service-worker.ts` — registers the service worker that keeps the app
    loadable offline: it builds its cache at runtime from the canonical
    documents and assets it actually serves (no build-time precache list).
- `public/sw.js` — the static service worker that makes the app load with no internet: it caches the canonical documents and assets it observes at runtime (no build-time precache list).
- `src/client/ws-client.ts` — routes every edit through the offline queue first,
  then sends it live when possible.

## What about "conflicts"? (forking)

Here's the tricky part of offline editing: **two people might edit the same thing
in two different places, and now no one agrees.**

The simple, honest answer this app uses is **"avoid merging: fork."**

- If the server and your device agree, your queued edits just get applied — easy.
- If the server changed *and* you changed while offline, the app can't know how to
  combine them fairly. So it **forks** — it copies everything into a **brand-new
  room** and replays your offline work there. You never lose your edits, and you
  never get a messy half-merge. (Fancier merge strategies exist, but "fork when
  in doubt" is the safe, clear starting point.)

### Before offering a fork: prove it's a real conflict

A fork prompt is a big deal, so the app tries hard **not** to show one unless a
genuine two-way conflict remains:

- **The server keeps its base up to date.** Every snapshot the server hands over
  — the WebSocket `full-sync` reply now carries the room's `revision` — is
  adopted as your local base (forward-only; `dirty` stays true while the outbox
  still has rows). Without this, an online session delivered entirely over
  WebSockets would leave a stale base behind and the *next* reconnect would look
  "diverged" even though the server already has everything.
- **The settle window is deadline-based, not attempt-counted.** When a replay
  comes back "diverged", the client polls the authoritative room state for up to
  **10 seconds** (every 500ms) to see whether the server already absorbed the
  queued ops live over the WebSocket. A reconnecting network can leave `/state`
  unreachable for many seconds — those failures are retried, not counted as
  evidence of a conflict. If the machine goes offline mid-settle, the deadline
  is extended (up to a 30s cap) instead of burning the budget.
- **An unreachable or offline settle never prompts.** If the window expires
  while offline, or the server was never successfully reached during it, the
  outbox is simply kept and the sync retried later — no fork prompt. Likewise,
  if connectivity drops *during* reconciliation, the fork offer is aborted
  outright (`Local changes kept — will retry when back online`).
- **Only then: fork.** A fork prompt fires solely when the deadline expired
  *while online*, with successful state fetches, whose snapshots never contained
  your queued ops — i.e. a real two-way conflict.

> Think of it like two writers editing the same document. Sometimes you can just
> combine their notes. When you genuinely can't, you make a fresh copy — a fork —
> so nobody loses their words. But first you make sure the other writer's notes
> are really there: a dropped connection is not an argument.

## Why it matters

Offline-first is what makes the app **feel unstoppable and trustworthy**. Your
drawing is never hostage to a dropped connection. It's also the feature that makes
things like a **turn-based chessboard** on a shared canvas feel natural: two people
on separate offline copies can take turns, and the work reconciles when they
reconnect. It's a big reason this app stands out from a plain "always-online" toy.

---

## You've made it 🎉

If you've read the pages in order, you now know the whole story:

1. A **Cloudflare Worker** runs the server everywhere, close to everyone.
2. **Hono** is the menu that routes each request.
3. **SSR** makes the first page view fast and complete.
4. **Durable Objects** give each room a single, remembering boss.
5. **SQLite** is the durable record of the drawing.
6. **WebSockets** carry the live conversation while people draw together.
7. **Vite** assembles server + client into something deployable.
8. **Offline-first** lets you keep drawing with no internet and sync later.

Now go back to the main docs, or open the code and find each story's file — you
know exactly what you're looking at. 🖊️
