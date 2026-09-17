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
  - `connectivity.ts` — the app's "am I online?" check (and it's *pessimistic*:
    it assumes offline until proven otherwise).
  - `database.ts` — the in-browser storage (IndexedDB) + the queued outbox.
  - `sync.ts` — the "sync now that I'm back" engine.
  - `service-worker.ts` — registers the service worker that pre-caches the app.
- `public/sw.js` — the service worker that makes the app load with no internet.
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

> Think of it like two writers editing the same document. Sometimes you can just
> combine their notes. When you genuinely can't, you make a fresh copy — a fork —
> so nobody loses their words.

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
