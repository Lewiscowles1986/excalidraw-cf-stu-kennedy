# 7. What is Vite & the build?

## The problem it solves

So far we've met a lot of pieces: a **Cloudflare Worker** server, **Hono** routing,
**SSR** page-building, a **Durable Object**, **SQLite** storage, **WebSockets**,
and a browser **canvas**. They're scattered across many files, written in modern
TypeScript/JSX, split into dozens of modules.

Browsers and the cloud can't run that directly. They need a **packaged, tidy**
version of it. Something has to gather all those little pieces, translate the
fancy modern syntax, and bundle them into files that actually run.

That gathering job is **the build**, and **Vite** is the tool that does it.

## What Vite is

**Vite** is a *build tool* — like a **factory assembly line** for your code:

- It reads all your source files.
- It translates modern TypeScript/JSX into plain JavaScript.
- It **bundles** them (folds many small files into a few big efficient ones) so the
  browser makes fewer downloads.
- It also gives you a **dev server** for your own machine that rebuilds instantly
  as you type (that's the "instant reload while you code" superpower).

> Vite = **the assembler**. It turns a drawer full of parts into a finished, ready
> to-ship product — and keeps a fast local preview you can work in.

## The subtle, important part: this is a *Worker* build, not a plain website

Most Vite projects build a simple static website. **This one builds a Cloudflare
Worker**, and that changes what the build does. In `vite.config.ts` you'll see two
extra plugins bolted onto Vite:

1. **`@cloudflare/vite-plugin`** — this is what makes Vite build/run a *Worker*,
   not just a website. It understands the `wrangler.jsonc` config (the Worker's
   ID card) — so when you build, you get both:
   - the **client bundle** (the browser canvas + offline code + style), and
   - the **Worker bundle** (the server: Hono, SSR, Durable Object).
2. **`vite-ssr-components`** — this is what lets the server *print* the page
   (the SSR story) using normal-looking components.

So "run the build" actually means **"assemble BOTH the server and the client —
and make sure they agree on the same asset paths."** That's the coupled part: the
server's page template (`renderer.tsx`) and the browser assets have to match.

### Where in the code?

- `vite.config.ts` — the factory's settings (which plugins, so which kind of build).
- `package.json` → the `scripts` — `build` (run Vite), plus `dev`/`preview`/`deploy`.
- `public/` — bits copied through *as-is* (like `sw.js`, the committed static service worker, and
  `favicon.ico`) that don't need bundling.

## What "deploy" does

For a Worker, "deploying" is the build **plus** handing the finished Worker to
Cloudflare (usually via the command-line tool **wrangler**). In `package.json`:

```
"deploy": "$npm_execpath run build && wrangler deploy"
```

Read it left-to-right:

- **`$npm_execpath run build`** → first, run the build (assemble everything).
- then **`wrangler deploy`** → now ship the assembled Worker to the world.

(In the **build-system** doc, that `$npm_execpath` is the "coupled" trick — it
re-runs the build with whatever package manager you're using, npm or bun.)

## Why it matters

Without Vite, the code would stay a collection of modern files nobody can run.
With it, a single command turns all the stories into **something real people can
open in a browser** — and a deploy puts that live on the internet. The build is the
moment all the ideas stop being separate and become *the app*.

---

**Next: [8. What does offline-first mean?](./offline-first.md)** — what happens
when you draw with no internet, and how it syncs later.
