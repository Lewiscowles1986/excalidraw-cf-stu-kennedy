import type { ExcalidrawElement } from '../../types/elements';
import type { OfflineOp, OfflineRoom, ServerState, SyncResult } from '../../types/offline';
import { db } from './database';
import { isOnline, subscribeConnectivity } from './connectivity';
import { store } from '../state';
import { applyOpToElements } from './op-apply';
import { getStableUserId } from '../identity';

/** Temporary debug channel for diagnosing the drain flake. Exposed on window. */
function dbg(msg: string): void {
  try {
    const w = window as unknown as { __dbg?: string[] };
    w.__dbg = w.__dbg || [];
    w.__dbg.push(msg);
  } catch { /* noop */ }
}
const DEBUG: boolean = true;
function log(scope: string, msg: string): void {
  if (DEBUG) { console.log(`[sync:${scope}]`, msg); dbg(`${scope}|${msg}`); }
}

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

/** The base revision the local snapshot was last reconciled against. */
export function currentRevision(): number {
  return currentBase.revision;
}

/** Append a user mutation to the outbox and mark the room dirty. */
export async function enqueue(roomId: string, op: OfflineOp, revision: number): Promise<void> {
  await db.appendEvent(roomId, op, revision);
  log('enqueue', `room=${roomId} baseRev=${revision} online=${isOnline()} op=${op.type} ids=${op.type === 'element-update' ? op.elements.map(e => `${e.id}@v${e.version}`).join(',') : op.elementIds.join(',')}`);

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

/**
 * Attempt to sync the current room. Called on explicit reconnect events and
 * automatically after enqueue when online.
 */
export async function syncIfNeeded(roomId: string): Promise<void> {
  log('syncIfNeeded', `ENTER room=${roomId} cur=${currentRoom} dirty=${dirty} reconciling=${reconciling}`);
  if (!currentRoom || roomId !== currentRoom) return;
  if (reconciling || !dirty) return;

  const events = await db.getEvents(roomId);
  log('syncIfNeeded', `loaded ${events.length} events`);
  if (events.length === 0) {
    // Nothing queued; still refresh snapshot metadata.
    dirty = false;
    return;
  }

  reconciling = true;
  try {
    emitStatus('syncing', 'Syncing changes…');
    const result = await replayOutbox(roomId, events);
    log('syncIfNeeded', `events=${events.length} result=${result.status}${result.status === 'diverged' ? ` serverRev=${result.server.revision} serverEls=${result.server.elements.length}` : ` newRev=${result.revision}`}`);
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
  } catch (e) {
    // A transient network error during replay must not wedge the engine:
    // keep `dirty` set so the next connectivity probe or enqueue retries,
    // and avoid surfacing an unhandled rejection.
    log('syncIfNeeded', `replay THREW: ${String(e)}`);
    emitStatus('offline', 'Sync failed — will retry');
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
    body: JSON.stringify({ ops: opts, baseRevision, userId: getStableUserId() }),
  });
  const data = await res.json() as ServerState & { ok: boolean; diverged?: boolean; error?: string };

  if (data.diverged || !data.ok) {
    return { status: 'diverged', server: data, reason: 'server-moved' };
  }
  return { status: 'synced', revision: data.revision, lastEditAt: data.lastEditAt };
}

/** Decide what to do when local and server disagree. */
async function handleDivergence(roomId: string, server: ServerState): Promise<void> {
  const events = await db.getEvents(roomId);

  // First try to drain benignly: either there are no local edits (adopt the
  // server), or the server already holds our queued ops (they were delivered
  // live over the WebSocket, e.g. during a "believed-offline" race). Only if a
  // genuine two-way conflict remains do we offer to fork.
  if (await tryBenignDrain(roomId, events, server)) {
    return;
  }

  // Genuine conflict: both sides have edits the server hasn't absorbed.
  emitStatus('warning', 'Conflicting changes detected');
  const fork = await askUserToFork(roomId);
  if (fork) {
    await forkRoom(roomId);
  } else {
    // User declines to fork; keep local changes and stay offline-ish.
    emitStatus('offline', 'Local changes kept. Reconnect to retry.');
  }
}

/**
 * Return true when the divergence is not a real conflict — either there are no
 * local edits (fast-forward to server) or the server already contains every
 * queued op (drain the outbox and advance the base). When true, the caller
 * should not fork.
 */
async function tryBenignDrain(
  roomId: string,
  events: Awaited<ReturnType<typeof db.getEvents>>,
  initial: ServerState,
): Promise<boolean> {
  // Case 1: no local edits — simply adopt the server snapshot.
  let state = initial;
  if (events.length === 0 && !dirty) {
    store.updateElements(initial.elements);
    currentBase = { revision: initial.revision, lastEditAt: initial.lastEditAt };
    const local = await db.getRoom(roomId) ?? emptyRoom(roomId);
    local.elements = initial.elements;
    local.revision = initial.revision;
    local.lastEditAt = initial.lastEditAt;
    local.dirty = false;
    await db.saveRoom(local);
    emitStatus('online', 'Fetched latest changes');
    return true;
  }

  // Case 0: the server already reflects our queued ops. On reconnect a buffered
  // WebSocket frame and the /events replay can race, so the "diverged" snapshot
  // may not yet include the op the WS is about to deliver. Briefly re-poll the
  // authoritative /state to give it time to settle before giving up.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (serverHasAll(events, state.elements)) {
      dirty = false;
      currentBase = { revision: state.revision, lastEditAt: state.lastEditAt };
      await db.removeEvents(events.map(e => e.seq));
      const local = await db.getRoom(roomId) ?? emptyRoom(roomId);
      local.elements = state.elements;
      local.revision = state.revision;
      local.lastEditAt = state.lastEditAt;
      local.dirty = false;
      await db.saveRoom(local);
      emitStatus('online', 'All changes synced');
      log('tryBenignDrain', `attempt=${attempt} serverHasAll=TRUE draining ${events.length} events rev=${state.revision}`);
      return true;
    }
    log('tryBenignDrain', `attempt=${attempt} serverHasAll=false stateRev=${state.revision} stateEls=${state.elements.length} outbox=${events.map(e => e.op.type === 'element-update' ? e.op.elements.map(x => `${x.id}@v${x.version}`).join(',') : e.op.elementIds.join(',')).join(';')}`);
    const res = await fetch(`/api/rooms/${roomId}/state`).catch(() => null);
    if (res && res.ok) state = await res.json();
    await new Promise((r) => setTimeout(r, 250));
  }
  log('tryBenignDrain', `GAVE UP after 6 attempts`);
  return false;
}

/**
 * True if the server snapshot already contains every mutation in the outbox.
 * For an update, the server must have that element at >= the same version. For
 * a delete, the server list must no longer contain the id.
 */
function serverHasAll(
  events: Awaited<ReturnType<typeof db.getEvents>>,
  serverElements: ExcalidrawElement[],
): boolean {
  const elById = new Map(serverElements.map(el => [el.id, el] as const));
  return events.every((row) => {
    const op = row.op;
    if (op.type === 'element-update') {
      return op.elements.every((el) => {
        const serverEl = elById.get(el.id);
        const ok = !!serverEl && serverEl.version >= el.version && !serverEl.isDeleted;
        if (!ok) log('serverHasAll', `UPDATE ${el.id}@v${el.version} online=${isOnline()} serverEl=${serverEl ? `${serverEl.version} del=${serverEl.isDeleted}` : 'MISSING'}`);
        return ok;
      });
    }
    if (op.type === 'element-delete') {
      return op.elementIds.every((id) => !elById.has(id));
    }
    return true;
  });
}

/** Ask the user whether to fork (returns a promise resolved by the UI). */
function askUserToFork(roomId: string): Promise<boolean> {
  return new Promise((resolve) => {
    forkCallbacks = resolve;
    window.dispatchEvent(new CustomEvent('excalidraw:fork-prompt', { detail: { roomId } }));
    // Safety net: if no UI confirms within 30s, default to keeping local edits
    // (no fork, no data loss) so the reconnect/live path can resume instead of
    // wedging the sync engine in headless/CI environments.
    setTimeout(() => {
      if (forkCallbacks === resolve) {
        forkCallbacks = null;
        resolve(false);
      }
    }, 30_000);
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

  // Seed the new room on the server (attributed to this device's userId).
  await fetch(`/api/rooms/${newRoomId}/events`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ops: [{ type: 'element-update', elements }],
      baseRevision: 0,
      userId: getStableUserId(),
    }),
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
