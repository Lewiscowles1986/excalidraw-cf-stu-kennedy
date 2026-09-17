# 5. What are WebSockets?

## The problem they solve

Think about how the web normally talks. Every time your browser wants something
new, it has to **ask again**:

```
Browser: "Give me the page."
Server:  "Here's the page."
Browser: "Now give me the drawing."
Server:  "Here's the drawing."
Browser: "Now give me an updated drawing."
Server:  "Here it is."
Browser: "Now ... are there new changes?"
Server:  "Checking ... yes, here."
```

That's like sending a letter and waiting for a reply for every tiny thing. It's
fine for one-off pages, but it's *terrible* for a whiteboard where **two people
are watching the same drawing at the same time** and expect changes to appear
instantly. Nobody wants to send "got anything new?" every few milliseconds.

What you really want is a **phone call** — one line that stays open, where both
sides can talk at any moment without asking again.

## What a WebSocket is

A **WebSocket** is exactly that open line — a *persistent, two-way* connection
between your browser and the server that either side can use at any time.

- Opening it: your browser says "let's upgrade this to an open line" once.
- After that: **no more asking permission.** You draw a stroke → the server can
  instantly push that stroke to everyone else. They draw → it comes straight to you.

The key contrast to remember:

> Regular web = **postal mail** (ask, wait, reply, done).
> WebSocket = **an open phone line** (both sides talk freely, anytime).

## Why it matters here (real-time collaboration)

A whiteboard is collaborative *precisely* because changes travel live. When you
drag a box, everyone watching that room should see it move. That only works if
there's a live line from your browser to the room — and from the room to everyone
else. The **Durable Object** for the room is the switchboard: it holds all the
open lines, and whenever one side says something, it repeats it down the others.

> The drawing itself is remembered by the Durable Object in **SQLite** (story #6).
> WebSockets are the *live conversation* on top of that memory.

### Where in the code?

- `src/index.tsx` — the Worker catches the "upgrade to a live line" request at
  `/ws/:roomId` and hands it to the room's Durable Object.
- `src/do/drawing-room.ts` — inside the object: `webSocketMessage` (a line spoke),
  `webSocketClose` (a line hung up), and `broadcast` (repeat a message to the
  other open lines). This is the "switchboard."
- `src/client/ws-client.ts` — the browser end: opens the line, sends your strokes,
  and applies changes that arrive.

## The "live + remembered" teamwork

It helps to hold two things at once:

1. **WebSocket** = who's here *right now* and talking (in memory).
2. **SQLite** = what the drawing *is*, forever (durable).

If people leave, the sockets close and that's fine — the drawing is still in
SQLite. When someone new joins, the room loads the drawing back from SQLite and
opens a fresh WebSocket. Memory for the living conversation, durable storage for
the permanent record.

---

**Next: [6. What is SQLite?](./sqlite.md)** — the "memory" that a room's drawing
is actually stored in.
