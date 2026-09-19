import type { ExcalidrawElement } from './elements';

// The subset of client messages that mutate the canvas. Both the live
// WebSocket protocol and the offline outbox use these same shapes, so edits
// queue offline can later be replayed to the server unchanged.
export type MutationMessage =
  | { type: 'element-update'; elements: ExcalidrawElement[] }
  | { type: 'element-delete'; elementIds: string[] };

// Client -> Server messages
export type ClientMessage =
  | MutationMessage
  | { type: 'cursor-move'; userId: string; x: number; y: number; username: string }
  | { type: 'request-sync' }
  | { type: 'ping' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'element-update'; elements: ExcalidrawElement[]; senderId: string }
  | { type: 'element-delete'; elementIds: string[]; senderId: string }
  | { type: 'cursor-move'; userId: string; x: number; y: number; username: string }
  | { type: 'full-sync'; elements: ExcalidrawElement[]; revision?: number; lastEditAt?: number }
  | { type: 'pong' }
  | { type: 'user-joined'; userId: string; username: string; userCount: number }
  | { type: 'user-left'; userId: string; userCount: number };
