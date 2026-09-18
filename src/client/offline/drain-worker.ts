// Background drain worker (module Web Worker).
//
// Owns every room the client knows about EXCEPT the active one: the
// main-thread sync engine (sync.ts) owns the room that is open on the canvas,
// so this worker always skips it (prevents double-replay races). All it does
// is push each non-active room's IndexedDB outbox to POST /api/sync/drain and
// reconcile the local snapshot with the per-room results.
//
// CRITICAL: this file runs in a worker — it must never touch window/DOM. Its
// only imports are the database handle and the pure op applier (plus types),
// both of which are verified DOM-free.
import { db } from './database';
import { applyOpToElements } from './op-apply';
import type { OfflineRoom } from '../../types/offline';
import type { DrainWorkerIn, DrainWorkerOut } from './drain-protocol';

const TICK_MS = 30_000;

let activeRoom: string | null = null;
let userId: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

function post(msg: DrainWorkerOut): void {
  (self as unknown as Worker).postMessage(msg);
}

function isOnline(): boolean {
  // Workers have navigator (no window dependency here).
  return navigator.onLine;
}

/** One drain cycle: enumerate rooms, batch their outboxes to the server. */
async function drainCycle(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Only run while the machine is actually online; when offline everything
    // is left exactly as-is for the next kick.
    if (!isOnline()) return;

    const roomIds = await db.listRooms();
    const pending: Array<{ roomId: string; seqs: number[]; ops: unknown[]; baseRevision: number }> = [];

    for (const roomId of roomIds) {
      // The active room belongs to the main-thread sync engine — never replay
      // it here, or two engines could apply the same ops twice.
      if (roomId === activeRoom) continue;
      const events = await db.getEvents(roomId);
      if (events.length === 0) continue;
      const snapshot = await db.getRoom(roomId);
      pending.push({
        roomId,
        seqs: events.map(e => e.seq),
        ops: events.map(e => e.op),
        baseRevision: snapshot?.revision ?? 0,
      });
    }
    if (pending.length === 0) return;

    const res = await fetch('/api/sync/drain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rooms: pending.map((p) => ({
          roomId: p.roomId,
          ops: p.ops,
          baseRevision: p.baseRevision,
          ...(userId ? { userId } : {}),
        })),
      }),
    });
    if (!res.ok) return; // keep everything, retry on the next kick

    const body = await res.json() as {
      results?: Array<{ roomId: string; ok?: boolean; diverged?: boolean; revision?: number; lastEditAt?: number }>;
    };
    const byRoom = new Map((body.results ?? []).map(r => [r.roomId, r]));

    for (const entry of pending) {
      const result = byRoom.get(entry.roomId);
      if (!result) {
        // No verdict for this room (transport hiccup): keep everything, the
        // next kick retries.
        continue;
      }
      const snapshot = await db.getRoom(entry.roomId);
      if (result.diverged || !result.ok) {
        // Diverged: the server moved on. Keep the queued events for the user
        // to reconcile; flag the snapshot dirty so nothing pretends it synced.
        const local: OfflineRoom = snapshot ?? {
          roomId: entry.roomId,
          revision: entry.baseRevision,
          elements: [],
          lastEditAt: 0,
          dirty: true,
          updatedAt: Date.now(),
        };
        local.dirty = true;
        local.updatedAt = Date.now();
        await db.saveRoom(local);
        post({ type: 'diverged', roomId: entry.roomId });
        continue;
      }
      // Synced: drop the replayed events and fold the ops into the snapshot.
      await db.removeEvents(entry.seqs);
      const local: OfflineRoom = snapshot ?? {
        roomId: entry.roomId,
        revision: entry.baseRevision,
        elements: [],
        lastEditAt: 0,
        dirty: false,
        updatedAt: Date.now(),
      };
      for (const op of entry.ops as Parameters<typeof applyOpToElements>[1][]) {
        applyOpToElements(local.elements, op);
      }
      local.revision = result.revision ?? local.revision + 1;
      local.lastEditAt = result.lastEditAt ?? Date.now();
      local.dirty = false;
      local.updatedAt = Date.now();
      await db.saveRoom(local);
      post({ type: 'drained', roomId: entry.roomId, count: entry.seqs.length });
    }
  } catch {
    // Network/fetch/IDB errors must never escape a cycle — the outbox survives
    // untouched and the next kick (or 30s tick) retries.
  } finally {
    draining = false;
  }
}

self.onmessage = (e: MessageEvent<DrainWorkerIn>) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'kick':
      void drainCycle();
      break;
    case 'active-room':
      activeRoom = msg.roomId;
      // First 'active-room' message is the boot signal: start the 30s ticker.
      if (timer === null) {
        timer = setInterval(() => {
          if (isOnline()) void drainCycle();
        }, TICK_MS);
      }
      break;
    case 'identity':
      userId = msg.userId;
      break;
    case 'stop':
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      break;
  }
};