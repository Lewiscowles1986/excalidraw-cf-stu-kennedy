import { Hono } from 'hono';
import type { CloudflareBindings } from './types/env';
import { renderer } from './renderer';
import drawingRoutes from './routes/drawing';
import apiRoutes from './routes/api';
import sseRoutes from './routes/sse';

export { DrawingRoom } from './do/drawing-room';

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(renderer);

// Mount routes
app.route('/', drawingRoutes);
app.route('/', apiRoutes);
app.route('/', sseRoutes);

// WebSocket upgrade for drawing rooms
app.get('/ws/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }

  const id = c.env.DRAWING_ROOM.idFromName(roomId);
  const stub = c.env.DRAWING_ROOM.get(id);

  const url = new URL(c.req.url);
  return stub.fetch(new Request(`https://do/ws${url.search}`, {
    headers: c.req.raw.headers,
  }));
});

export default app;
