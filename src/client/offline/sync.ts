import type { ExcalidrawElement } from '../../types/elements';
import type { OfflineOp, OfflineRoom, ServerState, SyncResult } from '../../types/offline';
import { db } from './database';
import { isOnline, subscribeConnectivity } from './connectivity';
import { store } from '../state';

// Sync engine
// ===========
// Every local mutation is captured via wsClient and appended to the IndexedDB
// event log (the outbox) BEFORE the socket. When the store snapshot is dirtied,
// we mark the room dirty. On reconnect, the outbox is replayed to the server:
//   - if the server revision matches our base, the ops apply cleanly (synced).
//   - otherwise we have a divergence. If the user made no offline edits we can
//     simply adopt the server state (fast-forward). If both sides moved, we ask
//     the user to fork into a new room and replay the local event log there.

interface SyncState {
  revision: number;
  lastEditAt: number;
}

let currentRoom: string | null = null;
let currentBase: SyncState = { revision: 0, lastEditAt: 0 };
let dirty = false;
let reconciling = false;
let forkCallbacks: ((doFork: boolean) => void) | null = null;

/** Notify the sync engine that a room became the active canvas. */
export async function startRoom(roomId: string): Promise<OfflineRoom | undefined> {
  currentRoom = roomId;
  dirty = false;
  currentBase = { revision: 0, lastEditAt: 0 };

  const local = await db.getRoom(roomId);

  // If we were offline and there's a cached copy, restore it immediately so the
  // canvas is interactive solo while offline.
  if (local) {
    store.updateElements(local.elements);
    currentBase = { revision: local.revision, lastEditAt: local.lastEditAt };
    dirty = local.dirty;
    if (dirty) emitStatus('offline', 'Local changes pending sync');
  }

  return local;
}

/** The current offline room id, if any. */
export function currentRoomId(): string | null {
  return currentRoom;
}

/** Append a user mutation to the outbox and mark the room dirty. */
export async function enqueue(roomId: string, op: OfflineOp, revision: number): Promise<void> {
  await db.appendEvent(roomId, op, revision);

  if (roomId === currentRoom) {
    dirty = true;
    // Persist the optimistic change into the local snapshot too.
    let local = await db.getRoom(roomId) ?? emptyRoom(roomId);
    applyOpToElements(local.elements, op);
    local.dirty = true;
    local.updatedAt = Date.now();
    await db.saveRoom(local);
  }
  emitStatus(isOnline() ? 'syncing' : 'offline', 'Changes queued locally');
  // Try to flush immediately if we happen to be online.
  if (isOnline()) void syncIfNeeded(roomId);
}

/** Create a fresh room snapshot. */
function emptyRoom(roomId: string): OfflineRoom {
  return {
    roomId,
    revision: 0,
    elements: [],
    lastEditAt: 0,
    dirty: false,
    updatedAt: Date.now(),
  };
}

function applyOpToElements(elements: ExcalidrawElement[], op: OfflineOp): void {
  const map = new Map(elements.map(e => [e.id, e]));
  if (op.type === 'element-update') {
    for (const el of op.elements) map.set(el.id, el);
  } else if (op.type === 'element-delete') {
    for (const id of op.elementIds) {
      const existing = map.get(id);
      if (existing) map.set(id, { ...existing, isDeleted: true });
    }
  }
  elements.length = 0;
  elements.push(...map.values());
}

/**
 * Attempt to sync the current room. Called on explicit reconnect events and
 * automatically after enqueue when online.
 */
export async function syncIfNeeded(roomId: string): Promise<void> {
  if (!currentRoom || roomId !== currentRoom) return;
  if (reconciling || !dirty) return;

  const events = await db.getEvents(roomId);
  if (events.length === 0) {
    // Nothing queued; still refresh snapshot metadata.
    dirty = false;
    return;
  }

  reconciling = true;
  try {
    emitStatus('syncing', 'Syncing changes…');
    const result = await replayOutbox(roomId, events);
    if (result.status === 'diverged') {
      await handleDivergence(roomId, result.server);
      return;
    }
    if (result.status === 'synced') {
      dirty = false;
      currentBase = { revision: result.revision, lastEditAt: result.lastEditAt };
      await db.removeEvents(events.map(e => e.seq));
      const local = await db.getRoom(roomId);
      if (local) {
        local.dirty = false;
        local.revision = result.revision;
        local.lastEditAt = result.lastEditAt;
        await db.saveRoom(local);
      }
      emitStatus('online', 'All changes synced');
    }
  } finally {
    reconciling = false;
  }
}

/** Send the whole outbox to the server with an optimistic revision check. */
async function replayOutbox(roomId: string, events: Awaited<ReturnType<typeof db.getEvents>>): Promise<SyncResult> {
  const opts = events.map(e => e.op);
  const baseRevision = currentBase.revision;

  const res = await fetch(`/api/rooms/${roomId}/events`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops: opts, baseRevision }),
  });
  const data = await res.json() as ServerState & { ok: boolean; diverged?: boolean; error?: string };

  if (data.diverged || !data.ok) {
    return { status: 'diverged', server: data, reason: 'server-moved' };
  }
  return { status: 'synced', revision: data.revision, lastEditAt: data.lastEditAt };
}

/** Decide what to do when local and server disagree. */
async function handleDivergence(roomId: string, server: ServerState): Promise<void> {
  // Case 1: no local edits since we went offline — simply adopt the server.
  const events = await db.getEvents(roomId);
  if (events.length === 0 && !dirty) {
    store.updateElements(server.elements);
    currentBase = { revision: server.revision, lastEditAt: server.lastEditAt };
    const local = await db.getRoom(roomId) ?? emptyRoom(roomId);
    local.elements = server.elements;
    local.revision = server.revision;
    local.lastEditAt = server.lastEditAt;
    local.dirty = false;
    await db.saveRoom(local);
    emitStatus('online', 'Fetched latest changes');
    return;
  }

  // Case 2: both sides moved — offer to fork.
  emitStatus('warning', 'Conflicting changes detected');
  const fork = await askUserToFork(roomId);
  if (fork) {
    await forkRoom(roomId);
  } else {
    // User declines to fork; keep local changes and stay offline-ish.
    emitStatus('offline', 'Local changes kept. Reconnect to retry.');
  }
}

/** Ask the user whether to fork (returns a promise resolved by the UI). */
function askUserToFork(roomId: string): Promise<boolean> {
  return new Promise((resolve) => {
    forkCallbacks = resolve;
    window.dispatchEvent(new CustomEvent('excalidraw:fork-prompt', { detail: { roomId } }));
  });
}

/**
 * Create a new room seeded from the local snapshot and the replayed event log,
 * then switch to it. This avoids merge conflicts entirely.
 */
export async function forkRoom(origRoomId: string): Promise<string | null> {
  const local = await db.getRoom(origRoomId) ?? emptyRoom(origRoomId);
  const events = await db.getEvents(origRoomId);

  // Rebuild the forked canvas: apply all queued ops on top of the snapshot.
  const elements = [...local.elements];
  for (const e of events) applyOpToElements(elements, e.op);

  const newRoomId = crypto.randomUUID().substring(0, 8);

  // Seed the new room on the server.
  await fetch(`/api/rooms/${newRoomId}/events`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops: [{ type: 'element-update', elements }], baseRevision: 0 }),
  }).catch(() => {
    // If still offline, the fork is created locally and will sync on reconnect.
  });

  // Persist locally as a fresh room, and wipe the old room's outbox.
  const fresh: OfflineRoom = {
    roomId: newRoomId,
    revision: 0,
    elements,
    lastEditAt: 0,
    dirty: true,
    updatedAt: Date.now(),
  };
  await db.saveRoom(fresh);
  await db.deleteRoom(origRoomId);

  // Drop the old room's live data and switch the active canvas to the fork.
  currentRoom = newRoomId;
  currentBase = { revision: 0, lastEditAt: 0 };
  dirty = true;
  store.elements = new Map(elements.map(e => [e.id, e]));
  store.clearSelection();
  store.notify();
  store.setAppState({ roomId: newRoomId });

  if (forkCallbacks) {
    forkCallbacks(true);
    forkCallbacks = null;
  }

  emitStatus('online', `Forked into room ${newRoomId}`);
  window.dispatchEvent(new CustomEvent('excalidraw:forked', { detail: { newRoomId, origRoomId } }));
  // Attempt sync of the new room right away (seed + any local changes).
  if (isOnline()) void syncIfNeeded(newRoomId);
  return newRoomId;
}

/** Reject a pending fork prompt with the given decision. */
export function answerFork(doFork: boolean): void {
  if (forkCallbacks) {
    forkCallbacks(doFork);
    forkCallbacks = null;
  }
}

function emitStatus(kind: string, message: string): void {
  window.dispatchEvent(new CustomEvent('excalidraw:sync-status', { detail: { kind, message, roomId: currentRoom } }));
}

// Auto-sync whenever connectivity returns.
subscribeConnectivity((online) => {
  if (online && currentRoom) {
    emitStatus('syncing', 'Online — syncing…');
    void syncIfNeeded(currentRoom);
  } else if (!online) {
    emitStatus('offline', 'Offline — edits are stored locally');
  }
});
