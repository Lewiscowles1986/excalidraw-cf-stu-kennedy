# 1. What is a Cloudflare Worker?

## The problem it solves

Making an app public on the internet used to work like this:

1. You buy a **server** — a computer you rent that sits in one building somewhere.
2. You install your software on it and leave it running 24/7.
3. People all over the world send it messages ("give me the page"), and it answers.

That works, but it has an uncomfortable part: *your server lives in one place*.
If you're in London and your server is in a building in, say, Virginia, every
message you send to it has to travel across the ocean and back. For a whiteboard
where two people draw at the same time, that round-trip is the difference between
"instant" and "laggy."

Also, one server is a single point of failure. It gets popular → it slows down.
It crashes → everyone is offline.

## What a Worker is

Cloudflare has data centers in *hundreds* of cities worldwide. A **Cloudflare
Worker** is a small program that Cloudflare runs for you right inside those data
centers — so it runs **close to whoever is asking for it**, wherever they are.

Think of it this way:

- A **traditional server** is a single checkout till in one shop. Everyone queues
  for it.
- A **Worker** is like putting a tiny, identical till in *every shop on earth*.
  No matter where you walk in, there's a till right there, and they all do the
  same job.

The clever, slightly magical part: **you write the Worker once, and Cloudflare
copies and runs it everywhere.** You never buy a machine, never worry about
"too many users," and never care where it physically lives. It just *is* near you.

## Why it earns its place in this project

A real-time collaborative whiteboard is the *perfect* use case:

- It's **worldwide** — people draw together from different countries.
- It needs to feel **instant** — a laggy cursor makes drawing unpleasant.
- It can **spike** — 5 people today, 500 tomorrow.

A Worker gives all three for free: the code is close to everyone, and running it
doesn't care how many people come. **This whole server is one Worker.**

### Where in the code?

- `wrangler.jsonc` — the Worker's "ID card." It tells Cloudflare the app's name,
  which file is the entry point (`main: ./src/index.tsx`), and what special
  storage the Worker needs (we'll meet that in the **Durable Objects** story).
- `src/index.tsx` — the actual Worker program. Scroll down to where it says
  `export default app;` — that's the thing Cloudflare runs everywhere.

## Why it matters

Without a Worker, you'd be renting a server, configuring it, and hoping it stays
up. With a Worker, **"serving the app" is a solved problem** — you concentrate on
writing the drawing code instead of keeping a machine alive.

---

**Next: [2. What is Hono?](./hono.md)** — now that we have a Worker, how does it
decide what to do when a message arrives?
