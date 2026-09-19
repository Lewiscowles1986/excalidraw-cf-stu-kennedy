import { Hono } from 'hono';
import type { CloudflareBindings } from '../types/env';
import { DrawingPage } from '../views/drawing-page';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Landing page
app.get('/', (c) => {
  return c.render(
    <div class="landing">
      <div class="landing-content">
        <h1 class="landing-title">Excalidraw-CF</h1>
        <p class="landing-subtitle">Professional diagramming, powered by Cloudflare</p>
        <div class="landing-actions">
          <a href="/new" class="landing-btn primary">
            New Drawing
          </a>
          <form class="join-form" action="/join" method="get">
            <input
              type="text"
              name="room"
              placeholder="Enter room ID..."
              class="join-input"
            />
            <button type="submit" class="landing-btn secondary">
              Join
            </button>
          </form>
        </div>
      </div>
    </div>
  );
});

// Create new room
app.get('/new', (c) => {
  const roomId = crypto.randomUUID().substring(0, 8);
  return c.redirect(`/d/${roomId}`);
});

// Join existing room
app.get('/join', (c) => {
  const room = c.req.query('room');
  if (!room) return c.redirect('/');
  return c.redirect(`/d/${room}`);
});

// Offline canvas shell: the same DrawingPage SSR'd WITHOUT a roomId. The
// service worker precaches this document and serves it for offline
// navigations to /d/:roomId, /new and /join — the client then derives the
// real roomId from location.pathname at boot (see src/client/canvas.ts),
// so one cached document covers every canvas-shaped URL.
app.get('/shell', (c) => {
  return c.render(<DrawingPage />);
});

// Drawing room page
app.get('/d/:roomId', (c) => {
  const roomId = c.req.param('roomId');
  return c.render(<DrawingPage roomId={roomId} />);
});

export default app;
