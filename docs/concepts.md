# excalidraw-cf — Concepts, told as stories

This repo is a collaborative whiteboard (like Excalidraw / Figma / Miro) that
lives on the internet. Before anything else, it's worth understanding one thing:

> This app is **not one program**. It's a few programs that talk to each other —
> a server that lives in the cloud, and a canvas that runs in your browser.

Each page below takes **one** of the big ideas, tells the story of *why* it
exists and *what problem it solves*, then shows where it shows up in this repo
and why it matters. They build on each other, so read them roughly in order:

| # | Idea | What it answers |
|---|------|-----------------|
| 1 | [A Cloudflare Worker](./concepts/cloudflare-worker.md) | Where does the server live? How can it serve the whole world without you paying for a server? |
| 2 | [Hono](./concepts/hono.md) | How does the server decide what to do when a request arrives? |
| 3 | [Server-Side Rendering (SSR)](./concepts/ssr.md) | Why is the page partly built on the server before it reaches your browser? |
| 4 | [Durable Objects](./concepts/durable-objects.md) | How does the app remember each whiteboard's drawing without forgetting it? (Persistence) |
| 5 | [WebSockets](./concepts/websockets.md) | How do two people on the same whiteboard see each other's changes live? |
| 6 | [SQLite](./concepts/sqlite.md) | What is the "memory" that a room's drawing is stored in? |
| 7 | [Vite & the build](./concepts/vite-build.md) | How do all these pieces get packaged so browsers and the cloud can use them? |
| 8 | [Offline-first (local-first)](./concepts/offline-first.md) | What happens when you draw with no internet — and how does it sync later? |

> If you only read one thing, read **Durable Objects** — it's the most
> cloud-specific, the easiest to picture as "magic," and it's why this app can
> remember a drawing after you close your laptop.

---

## The 30-second mental model

- You open your browser and visit the app.
- A **server** hands you the page. That server is a **Cloudflare Worker** —
  a small program that Cloudflare runs in data centers all over the world, near you.
- The server uses **Hono** to route your request (landing page? a specific room?)
  and **SSR** to bake the page's HTML before sending it.
- Your browser then runs the big **canvas** program. This is the actual whiteboard.
- When you draw, that drawing must be **remembered**. A **Durable Object** —
  one per room — stores it in **SQLite** and keeps a running list of live connections.
- When someone else is on the same room, a **WebSocket** shuttles your strokes to
  them in real time.
- If you lose the internet, the app **keeps working** (offline-first): your edits
  are saved locally in your browser and synced to the server when you're back.

---

## Why separate stories?

The short label "a Hono + SSR + Durable Objects app" is dense with jargon. Each
page unpacks one of those words so you never have to "just know." You'll come back
to these as you read the real code — the file names in each story are the exact
places to look.

**Now start with [1. What is a Cloudflare Worker?](./concepts/cloudflare-worker.md)**
