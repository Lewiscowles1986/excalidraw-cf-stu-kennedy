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
      // Ask the sync engine to reconcile once we're connected.
      setTimeout(() => {
        void syncIfNeeded(roomId);
      }, 0);
    });
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
