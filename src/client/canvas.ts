import '@starfederation/datastar/bundles/datastar';
import { initRenderer, renderScene } from './renderer';
import { setupInteraction, getSelectionBox } from './interaction';
import { setupShortcuts } from './shortcuts';
import { setupBridge } from './bridge';
import { store } from './state';
import { worldToScreen } from './camera';
import { wsClient } from './ws-client';
import { startConnectivityMonitor } from './offline/connectivity';
import { registerServiceWorker } from './offline/service-worker';
import { startRoom, syncIfNeeded } from './offline/sync';
import { setupOfflineUI } from './offline/offline-ui';
import { startDrainWorker, setActiveDrainRoom } from './offline/drain';

let canvas: HTMLCanvasElement;
let animationId: number;

export function init(): void {
  canvas = document.getElementById('excalidraw-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  initRenderer(canvas);
  setupInteraction(canvas);
  setupShortcuts();
  setupBridge();

  // Offline-first: register the service worker and start connectivity detection.
  registerServiceWorker();
  startConnectivityMonitor();
  setupOfflineUI();

  // Offline route reconciliation, BEFORE the /d/ match. When the SW served
  // the precached '/shell' document instead of the server redirect (i.e. we
  // are offline), /new and /join arrive as-is and are resolved client-side;
  // online these still server-redirect (network-first SW passes through) and
  // both paths converge on /d/:id.
  const path = location.pathname;
  if (path === '/new') {
    // Offline-friendly room minting: /new's server redirect is unavailable
    // offline (the SW serves the shell instead), so mint client-side.
    const id = crypto.randomUUID().substring(0, 8);
    history.replaceState(null, '', `/d/${id}`);
  } else if (path === '/join') {
    const room = new URLSearchParams(location.search).get('room');
    if (!room) {
      // replaceState would leave the roomless shell inert (toolbar alive, no
      // render loop); location.replace('/') boots the real landing — offline
      // the SW serves the precached '/' document.
      location.replace('/');
      return;
    }
    history.replaceState(null, '', `/d/${room}`);
  }

  // Center the view
  store.setAppState({
    scrollX: window.innerWidth / 2,
    scrollY: window.innerHeight / 2,
  });

  // Connect to room if roomId is in the URL
  const match = location.pathname.match(/^\/d\/(.+)$/);
  if (match) {
    const roomId = match[1];
    // Restore any cached local state first (works fully offline), then
    // attempt network + live sync.
    startRoom(roomId).then(() => {
      wsClient.connect(roomId);
      // The background drain worker must know which room the main thread owns
      // (it always skips it — the sync engine alone replays the active room).
      setActiveDrainRoom(roomId);
      // Ask the sync engine to reconcile once we're connected.
      setTimeout(() => {
        void syncIfNeeded(roomId);
      }, 0);
    });
    // Background drain: a worker pushes every OTHER known room's outbox to
    // /api/sync/drain. Only meaningful on a canvas page (the landing page has
    // no rooms to own), so it is started exactly here, once.
    startDrainWorker();
    // Periodic auto-save as backup (catches any missed persistence)
    setInterval(() => {
      if (!wsClient.isConnected() && store.elements.size > 0) {
        wsClient.flushAll();
      }
    }, 3000);
  }

  startRenderLoop();
}

async function loadElements(roomId: string): Promise<void> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/elements`);
    if (res.ok) {
      const elements = await res.json();
      if (Array.isArray(elements) && elements.length > 0) {
        store.updateElements(elements);
      }
    }
  } catch {
    // Silently fail - elements will load via WS sync if available
  }
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;

  const ctx = canvas.getContext('2d')!;
  // Reset transform before scaling to avoid accumulation
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function startRenderLoop(): void {
  function frame() {
    renderScene(canvas);
    renderSelectionBox();
    animationId = requestAnimationFrame(frame);
  }
  animationId = requestAnimationFrame(frame);
}

function renderSelectionBox(): void {
  const box = getSelectionBox();
  if (!box) return;

  const ctx = canvas.getContext('2d')!;
  const tl = worldToScreen(Math.min(box.x1, box.x2), Math.min(box.y1, box.y2));
  const br = worldToScreen(Math.max(box.x1, box.x2), Math.max(box.y1, box.y2));

  ctx.save();
  ctx.strokeStyle = '#4a90d9';
  ctx.fillStyle = 'rgba(74, 144, 217, 0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.restore();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
