# 2. What is Hono?

## The problem it solves

Now that you have a **Cloudflare Worker** — a program that runs everywhere and
answers messages — you still have to answer a question a million times a day:

> Someone visited my app. **What do they want, and what do I send back?**

A visitor might be:

- going to the homepage,
- asking to *create a new whiteboard*,
- asking to *join a specific whiteboard by its ID*,
- uploading their drawing,
- saving an edited shape,
- asking "is the server even there?" (a quick health-check ping).

If you answered all of that with hand-written `if` statements it would turn into
a hopeless tangle. **Hono** is the tool that makes answering those questions neat
and obvious.

## What Hono is

**Hono** (the "H" is for *H*TTP) is a **web framework** — a small, tidy way of
saying **"when a request matches that address, run this handler."**

You write it like a menu:

```ts
app.get('/new',            create_a_whiteboard)   // visiting /new → make a board
app.get('/join',           join_a_whiteboard)    // visiting /join → join one
app.post('/api/…/elements', save_shape)          // uploading a drawing → save it
app.get('/api/ping',       say_i_am_alive)       // "is the server there?"
```

When a request arrives, Hono looks up the address, calls the matching handler,
and the handler decides what to send back (the page, the drawing data, a "yes I'm
alive", and so on). That's it. A framework is just **a tidy way to organise "who
handles what."**

> Hono is deliberately tiny and fast. It was literally designed to run inside a
> Cloudflare Worker, so it fits this project like a glove.

## The special thing you'll see: "Bindings"

In `src/index.tsx` you'll notice something that looks a little strange:

```ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

The words inside the `< >` are called **generics** — think of them as a typed
label on the menu saying *"when a handler needs the cloud's special storage,
you can grab it as `c.env...`."* `CloudflareBindings` is the list of extra cloud
things this app is allowed to touch (like the Durable Object storage we meet in
story #4). So Hono isn't just routing — it's also *handing your handlers* the
cloud things they need, with the safety net of the type-checker.

### Where in the code?

- `src/index.tsx` — creates the app, hangs the menu up, and starts it.
- `src/routes/drawing.tsx`, `api.tsx`, `sse.tsx` — three sub-menus of handlers,
  each for one kind of task (pages / data / live-updates).
- `src/types/env.ts` — the `CloudflareBindings` list itself.

## Why it matters

Hono is the **traffic controller**. It makes "someone tapped the address /
somewhere" a solved, organised problem. Every other story — pages, storage,
live updates — is a handler hanging off this menu. It's the skeleton the whole
app is built around.

---

**Next: [3. What is Server-Side Rendering (SSR)?](./ssr.md)** — why is the page
sometimes already built before it even reaches your browser?
