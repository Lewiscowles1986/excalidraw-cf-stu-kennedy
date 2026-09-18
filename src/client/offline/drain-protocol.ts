// postMessage protocol shared by the background drain worker and its
// main-thread controller. Types only — safe for both sides to import.
export type DrainWorkerIn =
  | { type: 'kick' }
  | { type: 'active-room'; roomId: string | null }
  // Workers cannot read localStorage, so the main thread hands over the
  // stable device identity once at boot; the worker stamps it onto every
  // drain batch so HTTP replays attribute edits to this device.
  | { type: 'identity'; userId: string }
  | { type: 'stop' };

export type DrainWorkerOut =
  | { type: 'diverged'; roomId: string }
  | { type: 'drained'; roomId: string; count: number };