# Excalidraw-CF — Onboarding Guide

Welcome! This guide is written for someone who might not know anything yet — so if a term feels obvious to you, I apologize, and if a term feels scary, I promise it's not. We'll go from zero to running the app, then to deploying it to the internet.

## A) What is this project?

### A shared infinite canvas
You know how a piece of paper or a whiteboard has edges? An **infinite canvas** is a drawing surface with no edges — you can keep panning and zooming anywhere, forever. Instead of "fitting" your diagram into a frame, the frame grows to fit you.

This is useful because real designing is messy. You sketch, you move things, you zoom into one corner, you zoom way out to see the whole picture. Tools like Excalidraw, Figma, and Miro are built around this idea — it's how modern teams sketch diagrams, plan architecture, or brainstorm together.

"**Shared**" is the key word: when multiple people are on the same canvas at the same time, they each see the other's changes appear in real time — like a magical whiteboard everyone can write on at once. No emailing files back and forth, no "which version is this?"

### What is a "room"?
A **room** is a *named virtual space* for a canvas. The app is organised into rooms because a single global whiteboard used by everyone at once would be chaos — you'd see strangers' doodles mixed in with your work.

Instead, each room is its own sealed-off world with its own URL like `/d/<roomId>`. Anyone who knows the room's short ID can join it, and only the people in that room share the canvas. This is how the app stays organised: **one infinite canvas per room, shared only by that room's people.**

### What is a command-line interface (CLI)?
A **CLI** ("command-line interface") is a program you talk to by typing text commands into a terminal window, instead of clicking buttons in a graphical app. It looks like:

```
bunx wrangler dev
```

CLIs feel intimidating at first, but they're actually the most precise way to run setup steps — you can type an exact command, and the exact same thing happens on every computer. That makes them great for instructions: *"run this one line"* is simpler and more reliable than *"click here, then here, then here."* Most developer tools expose their power through a CLI, so learning one tool's CLI teaches you the pattern for all of them.

### What is the Wrangler CLI?
**Wrangler** is Cloudflare's official command-line tool. It's the "remote control" for everything Cloudflare-related in this project:

- `bunx wrangler dev` — runs the app **locally** on your machine (no internet needed).
- `bunx wrangler deploy` — uploads your code to Cloudflare's edge network so the whole world can use it.
- `bunx wrangler types` — reads your `wrangler.jsonc` config and generates TypeScript types for you.

In short: **Wrangler is the bridge between this code and Cloudflare.** You need it for local development, and you definitely need it to put the app online.

---

## B) Setup guides

The app depends on **Bun** (see section D for why). If you haven't installed Bun yet, do this once on macOS/Apple silicon:

```bash
brew install bun
```

Now pick one of the two guides below.

### Guide 1 — Quick start (no Cloudflare account)

This is the fastest way to see the app running. It works **without** a Cloudflare account because `bunx wrangler dev` runs everything locally on your machine. Great for exploring the code and getting your bearings.

```bash
# Install dependencies (from the project folder)
bun install

# Start the local dev server
bunx wrangler dev
```

Then open the URL Wrangler prints (typically `http://localhost:8787`). Click **New Drawing** or join an existing room by ID, and you should see the whiteboard.

> **Tip:** open the URL in two browser windows to see the collaborative real-time magic in action — anything you draw in one window appears in the other.

> **Note:** because this is a purely local run on one machine, the real-time collaboration only works between browsers *on your machine*. To collaborate with people on other machines, you'll want Guide 2.

### Guide 2 — Full setup with Cloudflare (for deploy + real-time rooms)

To put the app on the actual internet and let people in different places draw together, you need a real Cloudflare account. There are a few one-time steps:

1. **Sign up for a Cloudflare account.** Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a free account.
2. **Confirm your email.** Cloudflare sends a verification email — click the link in it to activate the account.
3. **Visit the dashboard: "Compute" → "Workers & Pages".** Log into [dash.cloudflare.com](https://dash.cloudflare.com), find **Compute** in the side menu, and open **Workers & Pages**.

   **Why this step matters:** simply signing up is *not* enough by itself. Opening **Workers & Pages** is what tells Cloudflare to provision a default Workers project/account behind the scenes. Until that exists, `wrangler deploy` (and Durable Objects) can fail or complain that you have no Workers setup to push to. This one click is the "activate your Workers workspace" moment.

4. **Authenticate Wrangler with your account.** Then, in your terminal from the project folder:

```bash
# Log into Cloudflare (opens a browser to authorize)
bunx wrangler login

# Build + deploy your app to the internet
bunx wrangler deploy
```

`wrangler login` pops open a browser where you confirm which Cloudflare account to link. After you authorize, Wrangler remembers you, and `bunx wrangler deploy` uploads your code and gives you a public URL like `https://excalidraw-cf.<your-subdomain>.workers.dev`. Anyone with that URL can now join your rooms and collaborate in real time.

### Why does Guide 1 work without an account, but Guide 2 needs one?

Here's the short version of how Cloudflare and Wrangler interact:

- **`bunx wrangler dev` works with no account** because it *doesn't talk to Cloudflare at all*. It spins up a local simulation of Cloudflare's environment right on your computer — including a local copy of your Durable Objects and SQLite. It's like rehearsing a play at home: you don't need a theater, just your own room.

- **`wrangler login` also works before you use the dashboard**, because logging in is just "connect Wrangler to your account" — it works as long as you have a (verified) account. That's why Guide 2 orders it *after* signup + email confirm: the login needs an account to attach to.

- **`wrangler deploy` (and real Durable Objects) absolutely require a real, verified, dashboard-activated account**, because for the first time it's actually shipping your code to Cloudflare's real network, spinning up real stateful Durable Objects, and using real storage. That act actually *touches* your account, so the account must exist and be ready. This is also exactly why the **"Compute → Workers & Pages"** dashboard step matters — it ensures that "ready" Workers workspace exists so deploy has somewhere to go.

---

## C) What each piece is, and why it earns its place

- **Bun** — the JavaScript runtime *and* package manager this project uses. It's a faster, friendlier drop-in replacement for npm/node. `brew install bun` gets both the runtime and the installer in one go, which is why it's a single command.

- **Wrangler** — Cloudflare's CLI (see section A). It's how we start the local server and how we deploy. It's the tool that understands the `wrangler.jsonc` config.

- **Wrangler config (`wrangler.jsonc`)** — the project's Cloudflare settings file. It declares the project name, which file is the server entry point (`./src/index.tsx`), and — critically — the **Durable Object binding** and its **migration**:
  ```jsonc
  "durable_objects": { "bindings": [{ "name": "DRAWING_ROOM", "class_name": "DrawingRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DrawingRoom"] }]
  ```
  The binding tells the app "the DrawingRoom class exists," and the migration tells Cloudflare to actually create its storage the first time.

- **Cloudflare Workers** — Cloudflare's edge-compute platform. "Workers are just code that runs in Cloudflare's data centers closest to the user." In this project, the Hono app in `src/index.tsx` *is* the Worker: it's the server that handles all the HTTP requests.

- **Durable Objects / the `DrawingRoom` class** — the heart of collaboration. A Durable Object is a **stateful** server-side object: unlike normal Worker code (which is stateless and might "reset" between requests), a Durable Object keeps its memory and its own data. The app creates **one `DrawingRoom` instance per room** and that instance is the single source of truth for that room. It holds the SQLite database and every connected WebSocket for that room, so all the clients in the room talk to one authoritative place. This is what keeps multiple people's edits consistent.

- **SQLite** — the database running *inside* each `DrawingRoom`. In `src/do/drawing-room.ts`, the constructor runs a migration that creates an `elements` table, and each drawing element (shape, line, text...) is a row there. It's Durable Objects' built-in storage, so no separate database server needs to be set up. Because each room's data lives in that room's Durable Object, you get per-room persistence for free.

- **WebSockets** — the "always-open" channel that makes real-time work. A regular HTTP request is like mailing a letter (ask, then wait for a reply, then it's done). A WebSocket is like a phone call that stays connected — both sides can talk *at any moment* without reconnecting. `src/index.tsx` handles the upgrade route at `/ws/:roomId`, and each `DrawingRoom` uses WebSockets to broadcast "someone drew this / someone moved their cursor / someone joined" instantly to everyone else in the room (`ws-client.ts` on the browser side).

- **Hono** — a small, modern web framework that makes writing routes easy and type-safe. The whole server is just `new Hono<{ Bindings: CloudflareBindings }>()` plus a few `app.get(...)` / `app.route(...)` calls. Notice the generics: the Cloudflare-specific bindings are piped straight into Hono, so the editor and TypeScript know that `c.env.DRAWING_ROOM` exists.

- **Server-side rendering (`renderer.tsx` + `routes/drawing.tsx`)** — the server generates the HTML *itself* to send to the browser, rather than sending an empty page and letting JavaScript build everything. `renderer.tsx` defines the shared HTML shell (head, title, styles, and the main client script), and `drawing.tsx` renders the landing/drawing pages. Why is this nice? The first thing you see loads fast and fully-formed before the heavy client JavaScript boots up.

- **`npm install` vs `bun install`** — `npm` and `bun` are two **package managers**: tools that read your `package.json` and download all the libraries (dependencies) the project needs into a `node_modules` folder. `npm` is the older, default one that ships with Node; `bun` is the faster modern replacement. This project was built around Bun, but the `package.json` scripts use `$npm_execpath` (as in `"deploy": "$npm_execpath run build && wrangler deploy"`) — a clever trick meaning *"use whichever package manager ran this."* So **npm works too** (`npm install`, `npm run dev`), but **`bun install` is preferred because it's much faster.** All the scripts — `dev`, `preview`, `deploy`, `build`, `cf-typegen` — behave the same under either.

---

## D) The exact commands for Bun users

**Install Bun (once), on macOS / Apple silicon:**
```bash
brew install bun
```

**Install dependencies and run locally:**
```bash
bun install
bunx wrangler dev
```

**Deploy to Cloudflare (needs Guide 2 setup first):**
```bash
bunx wrangler login
bunx wrangler deploy
```

**Regenerate the TypeScript types for your Worker config:**
```bash
bunx wrangler types --env-interface CloudflareBindings
```
(npm users would write `npm run cf-typegen`.)

> **What is `bunx wrangler`?** `bunx` is Bun's "run ad-hoc tools" command. It lets you run `wrangler` on demand *without installing it globally* — Bun finds it in the project's `devDependencies` and runs it. That's why you always see `bunx wrangler`, never just `wrangler`. It keeps the tool local to the project, exactly where it belongs.

### All the project scripts at a glance

| Script | Does what |
|--------|-----------|
| `bun run dev` | Start the Vite dev server (instant reloads while you code) |
| `bun run build` | Bundle the app for production |
| `bun run preview` | Build, then serve the built output locally to preview it |
| `bun run deploy` | Build, then `wrangler deploy` to ship it to the internet |
| `bun run cf-typegen` | Generate Cloudflare TypeScript types from `wrangler.jsonc` |
| `bun run test` | Run the Playwright interaction/offline test suite |

That's everything you need to go from "what is this?" to "I just drew on a shared canvas with a friend across the internet." Have fun! 🎨
