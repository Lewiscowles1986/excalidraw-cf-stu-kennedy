// Main-thread controller for the background drain worker.
//
// The worker itself is DOM-free; everything that touches window lives here:
// spawning the module worker, forwarding connectivity transitions as kicks,
// keeping it informed of the active room, and re-emitting its divergence
// reports as the standard sync-status CustomEvent.
import { subscribeConnectivity } from './connectivity';
import { currentRoomId } from './sync';
import { getStableUserId } from '../identity';
import type { DrainWorkerIn, DrainWorkerOut } from './drain-protocol';

let worker: Worker | null = null;

function send(msg: DrainWorkerIn): void {
  worker?.postMessage(msg);
}

/**
 * Start the background drain worker (once). Kicks it on every
 * connectivity → online transition and reports the current active room, so
 * the worker immediately skips the room the sync engine owns.
 */
export function startDrainWorker(): void {
  if (worker) return;
  try {
    worker = new Worker(new URL('./drain-worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    // A missing/blocked worker must never break the canvas: drain simply
    // stays with the main-thread engine.
    console.warn('[offline] drain worker failed to start', e);
    worker = null;
    return;
  }

  worker.onmessage = (e: MessageEvent<DrainWorkerOut>) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'diverged') {
      // Surface a background room's conflict through the same channel the
      // sync engine uses, so the existing status UI reacts unchanged.
      window.dispatchEvent(new CustomEvent('excalidraw:sync-status', {
        detail: { kind: 'warning', message: 'Background room has conflicting changes', roomId: msg.roomId },
      }));
    }
    // 'drained' is informational for now (no UI wiring required).
  };

  // Announce the room the main thread owns (boot signal for the worker's
  // 30s ticker) and hand over the stable identity — workers cannot read
  // localStorage, so attribution for HTTP replays is stamped from here.
  worker.postMessage({ type: 'active-room', roomId: currentRoomId() } satisfies DrainWorkerIn);
  worker.postMessage({ type: 'identity', userId: getStableUserId() } satisfies DrainWorkerIn);
  subscribeConnectivity((online) => {
    if (online) worker?.postMessage({ type: 'kick' } satisfies DrainWorkerIn);
  });
}

/**
 * Tell the worker which room the main-thread sync engine currently owns
 * (null when no room is open). The worker always skips this room.
 */
export function setActiveDrainRoom(roomId: string | null): void {
  worker?.postMessage({ type: 'active-room', roomId } satisfies DrainWorkerIn);
}