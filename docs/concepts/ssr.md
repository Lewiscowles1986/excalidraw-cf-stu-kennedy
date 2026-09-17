# 3. What is Server-Side Rendering (SSR)?

## The problem it solves

When your browser visits a website, it receives **HTML** — the text-and-structure
that describes a page: a title here, a button there, a canvas to draw on there.

There are two ways that HTML can come into existence:

**Bad way (Client-Side):** the server sends a nearly *blank* page plus a giant
pile of JavaScript. The JavaScript runs in your browser and *then* builds the page
you see. It's like being handed an empty stage and a script — you have to wait for
the actors to walk out and build the set before anything is visible. On a slow
laptop or slow internet, the page looks blank for ages.

**Better way (Server-Side Rendering, SSR):** the **server builds the page** and
sends you the finished HTML. What you open is already assembled. Then the browser
adds the interactive extras. It's like arriving at a theatre where the set is
already up — you can *see* the show instantly, and the actors warm up around it.

## What SSR means here

"Server-side rendering" = **the server does the first draft of the page's HTML,
so your first view is fast and complete.**

For this whiteboard app, the server (our Worker + Hono) is perfect for the job:
it already knows the room's ID from the address you typed, so it can send you a
page that's already labelled "this is the drawing room for room XYZ," already
loaded with the styles, and already pointing at the canvas program — before any
heavy client code boots up.

### Where in the code?

- `src/renderer.tsx` — the **shell**: the skeleton HTML (title, styles, the
  script tag that loads the canvas). The server stamps this shell around every page.
- `src/routes/drawing.tsx` — the **pages**: it decides what goes *inside* the shell
  (the landing page, or a specific drawing room), and the server renders it.
- The `jsxRenderer` + `vite-ssr-components` plugin — the machinery that lets the
  server "print" pages that *look* like normal HTML/JSX and sends the finished tags.

## The special thing to notice

Look at `src/renderer.tsx`. You'll see it references `/src/client/canvas.ts` as a
`<Script>` and `/src/style.css` as a `<Link>`. That's the *bridge* between the two
halves of the app:

- **The page shell is made on the server** (SSR).
- **The canvas is a program that runs in your browser** (the client).

SSR is what sews those two halves together — it's the server's way of saying
*"here's the page, and by the way, load this canvas program into it."*

## Why it matters

Without SSR, opening the app would feel slow and feel blank. With SSR, the first
thing you see is the finished page — and the fancy canvas adds its powers on top.
Better first impression, faster start, and it's how the server "knows" which room
to pre-load for you.

---

**Next: [4. What are Durable Objects?](./durable-objects.md)** — the important
one: how the app *remembers* each whiteboard without forgetting it.
