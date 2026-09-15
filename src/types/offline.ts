import type { ExcalidrawElement } from './elements';
import type { MutationMessage } from './protocol';

// A single offline operation captured in the outbox. Every user mutation is
// appended to the room's event log *before* any attempt to reach the server,
// so the client remains the source of truth while offline. On reconnect the
// log is replayed to the server.
//
// This derives from the shared MutationMessage so the offline outbox can never
// drift from the live WebSocket protocol — edits queued offline replay against
// the server unchanged.
export type OfflineOp = MutationMessage;

// The per-room snapshot stored in IndexedDB. It is the durable client-side
// copy of the canvas, kept even when the server is unreachable.
export interface OfflineRoom {
  roomId: string;
  // Incremental sequence — the local log position this snapshot was synced to.
  revision: number;
  elements: ExcalidrawElement[];
  // The last edit timestamp we observed for this room (from the server)
  // when we last reconciled, or 0 if never synced.
  lastEditAt: number;
  // Whether there are unsynced local edits queued.
  dirty: boolean;
  updatedAt: number;
}

// The server's view of a room (the /state response).
export interface ServerState {
  roomId: string;
  revision: number;
  lastEditAt: number;
  elements: ExcalidrawElement[];
}

// Result of replaying the outbox.
export type SyncResult =
  | { status: 'synced'; revision: number; lastEditAt: number }
  | { status: 'diverged'; server: ServerState; reason: 'no-local-edits' | 'server-moved' | 'base-mismatch' };
