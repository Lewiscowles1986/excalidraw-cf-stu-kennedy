# 6. What is SQLite?

## The problem it solves

You've drawn a rectangle, closed your laptop, come back tomorrow — and it should
still be there. Something has to **remember that drawing**, even while no one is
looking at it.

We already said the **Durable Object** is the "caseworker who keeps your file in
a locked drawer." But that's a metaphor — what is the *filing cabinet* actually
made of? That's where **SQLite** comes in.

## What SQLite is

**SQLite** is a **database** — a way to store and look up data in neat, reliable
tables. It's the most-used little database on the planet (every smartphone, every
browser, tons of apps lean on it).

Two things make SQLite perfect here:

1. **It's an embedded database** — no separate server software to install or
   maintain. It lives right *inside* the app (inside the Durable Object) and just
   works. For a cloud app, that means "give this object a database" is one line of
   config, not a whole extra machine to manage.
2. **It's durable** — what's written to it survives computer restarts, evictions,
   and crashes. It's the *permanent record*, exactly what "remember the drawing"
   needs.

## The mental model

Think of SQLite as **spreadsheet with superpowers**:

- Data lives in **tables** — like sheets in a workbook.
- Each table has **rows** (one per thing) and **columns** (the qualities of that
  thing).
- The Durable Object's SQLite is the *filing cabinet*; the drawing elements are
  the *files* in it.

## How this app uses it — the "elements" table

In `src/do/drawing-room.ts`, the room's database has one important **table** —
`elements` — and each row is **one shape on the whiteboard**:

| column | what it means |
|---|---|
| `id` | a unique name for that shape |
| `type` | is it a rectangle, a line, text, an arrow…? |
| `data` | the full description of the shape (where it is, its size, colour…) |
| `version` | how many times it's been edited (used to keep conflicting edits straight) |
| `is_deleted` | has the shape been deleted? (a soft flag, so history can recover it) |
| `updated_at` | when it was last changed |

So when you draw a rectangle, the room:
1. puts a new row into `elements`, and
2. tells everyone with a live **WebSocket** about it.

"Remembering the drawing" literally means **"saving the rows to SQLite."**

### Where in the code?

- `src/do/drawing-room.ts` — the room creates the `elements` table the first time
  it exists (look for the `CREATE TABLE IF NOT EXISTS elements (...)` line).
- It uses `this.sql` to read, insert, and update rows whenever you draw, move, or
  delete a shape.
- `wrangler.jsonc` — the one-line config that gives the Durable Object its
  database (`migrations` → `new_sqlite_classes`).

## Why it matters

SQLite is **the durable memory** that makes the whole "remember the drawing" story
concretely real. The Durable Object is *who* owns the room; SQLite is *what it
actually writes down*. One keeps the authority, one keeps the record — and the two
together are why your rectangle is still there tomorrow.

> Side note: SQLite inside a Durable Object is a lovely "free lunch" — you get a
> real database with zero extra servers to run. That's a big part of why this
> app is cheap and easy to host.

---

**Next: [7. What is Vite & the build?](./vite-build.md)** — how all these pieces
get packaged into something the world can actually use.
