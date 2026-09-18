// Stable per-device user identity.
//
// The app stays unauthenticated: room URLs are capabilities, not gated
// resources. This module provides the one identity the contribution model
// needs — a userId that is STABLE across page runs from the same device, so
// "rooms you've edited" can be attributed to the same person over time.
//
// Deliberately tiny and dependency-free: it is imported by ws-client.ts,
// sync.ts and drain.ts. Keeping it out of ws-client avoids an import cycle
// (ws-client already imports the offline module that sync.ts belongs to).
// Username is intentionally NOT persisted here — it stays cosmetic/random.

const STORAGE_KEY = 'excalidraw-cf:userId';

/** Read (or lazily mint + persist) the stable per-device userId. */
export function getStableUserId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // Storage unavailable/blocked (privacy mode, exotic embeds): degrade to a
    // per-run id rather than break the caller. Attribution simply does not
    // accumulate for that run.
    return crypto.randomUUID();
  }
}