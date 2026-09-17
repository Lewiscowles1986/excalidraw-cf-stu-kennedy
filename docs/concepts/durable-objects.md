# 4. What are Durable Objects? (the important one)

## The problem they solve

Here's a quiet thing that trips everyone up: **ordinary cloud programs forget
everything.**

Recall from the **Cloudflare Worker** story that a Worker can run *anywhere* and
be *copied anywhere*. That's great for reaching people worldwide — but it has a
trade-off: a plain Worker is **stateless**. The moment a request finishes, the
Worker is free to forget everything it was doing. The next request might be
handled by a *fresh copy of the program that never met you*.

For a whiteboard, "forgetting everything" is fatal. Your drawing has to be
**remembered** — across minutes, days, closing your laptop, and other people's
drawing on the same canvas. So the app needs something that *holds onto state*
and *is in one guaranteed place on purpose*. That's exactly what a **Durable
Object** is for.

## What a Durable Object is

A **Durable Object** is a special Cloudflare thing that is:

1. **Stateful** — it keeps memory and data *on purpose*, across requests, for as
   long as you need it.
2. **One instance, in one place** — for any given key, there is exactly *one*
   object that owns it, no matter how many copies of the Worker exist around the
   world.
3. **Backed by durable storage** — even if the computer running it is replaced,
   its data survives.

The mental model that I find most useful:

> A Worker is like a **receptionist who forgets your name the moment you walk
> away**. A Durable Object is like a **caseworker who keeps your file in a locked
> drawer** and is the *only* person with the key.

## How this app uses one — one object per whiteboard ("room")

Remember, Hono said this app is organised into **rooms** (a named space for a
canvas, with its own URL like `/d/<id>`). Here's the beautiful mapping:

> **For every room, the app creates one Durable Object — and that one object is
> the boss of that room.**

It's the single source of truth. Every drawing element a person adds, every live
connection, every "give me the current state" — all of it funnels to *that one
object* for that room. Because there's exactly one boss per room, there's never
conflicting copies of the drawing running around.

### Where in the code?

- `wrangler.jsonc` — this is where a Durable Object is **declared**:
  ```jsonc
  "durable_objects": { "bindings": [{ "name": "DRAWING_ROOM", "class_name": "DrawingRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DrawingRoom"] }]
  ```
  It tells Cloudflare "the app has a Durable Object called `DrawingRoom`, and it
  gets a database." The `migration` line is the "please actually create its
  storage the first time" instruction.
- `src/do/drawing-room.ts` — the `DrawingRoom` class itself. This IS the object.
  It remembers the room: where it stores the drawing (we meet that in **SQLite**),
  how it talks to connected people (we meet that in **WebSockets**), and how it
  answers "give me the current state."
- `src/index.tsx` — when someone visits `/d/<roomId>`, Hono does
  `DRAWING_ROOM.idFromName(roomId)` (find-or-create the object for that room) and
  hands the request to it. This is the wiring that makes "one object per room."

## The catch you must know (it's important for this repo)

Durable Objects are stateful, but **the in-memory part can still be evicted** —
Cloudflare can "shut down" a quiet object and reopen it later. That's fine *as
long as the important data lives in the durable storage, not just in memory.*

So this app follows one golden rule:

> **Memory is a cache. The durable storage is the truth.** Whenever an object
> needs state, it re-reads it from storage.

The drawing lives in **SQLite** (durable, survives shutdowns). The list of
*who is currently connected* lives in memory (and that's fine — if it's lost, the
next reconnect just re-adds the person). Getting that split right is the whole art,
and this repo does it deliberately.

## Why it matters

Durable Objects are the heart of the app. They're why a drawing **stays** after
you close your laptop, why two rooms never accidentally mix, and why there's a
single honest version of the truth. Without them, this would be a whiteboard that
forgets everything — useless. With them, it *remembers*, and does so in a way
that's actually cheap to run in the cloud.

---

**Next: [5. What are WebSockets?](./websockets.md)** — the other half of
collaboration: how live changes reach everyone at once.
