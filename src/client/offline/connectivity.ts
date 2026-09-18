// Connectivity detection.
//
// `navigator.onLine` is the trusted source of truth for whether the machine is
// connected to a network (product decision, 2026-09): the browser platform
// knows the machine's real network state, while request heuristics are
// brittle — a single failed request (DNS hiccup, slow server, captive portal)
// is NOT evidence of being offline. There is deliberately NO ping probe here:
// the app flips online/offline only when the browser itself says so, via the
// `online`/`offline` window events.

export type Connectivity = 'online' | 'offline';

type Listener = (state: Connectivity) => void;

// Seed the cache from navigator.onLine so early isOnline() readers see the
// machine's real state even before the monitor attaches its listeners.
let state: Connectivity =
  typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline';
const listeners = new Set<Listener>();
let started = false;

function dbg(msg: string): void {
  try {
    const w = window as unknown as { __dbg?: string[] };
    w.__dbg = w.__dbg || [];
    w.__dbg.push(msg);
  } catch { /* noop */ }
}

export function isOnline(): boolean {
  return state === 'online';
}

export function subscribeConnectivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(next: Connectivity, force = false): void {
  if (!force && next === state) return;
  dbg(`conn|setState ${state} -> ${next} navOnline=${navigator.onLine}`);
  state = next;
  for (const fn of listeners) fn(state);
  window.dispatchEvent(new CustomEvent('excalidraw:connectivity', { detail: { online: state === 'online' } }));
}

// ── Test/embedder override ──────────────────────────────────────────────────
// navigator.onLine cannot be stubbed per-test, so an explicit override is
// provided: `setConnectivityOverride('online' | 'offline')` pins the state
// (winning over navigator.onLine AND window events) and `null` hands control
// back to the browser. A boot-time hook is also supported: if
// `window.__connectivityOverride` is set before app boot (e.g. via
// addInitScript), it is honoured until an explicit override supersedes it.
//
// This hook is dev/test-only: it is compiled out of production builds (gated
// on `import.meta.env.DEV`, which Vite replaces with `false` in prod), so
// neither the API nor the boot-time hook can influence a production app.
let override: Connectivity | null = null;

function currentOverride(): Connectivity | null {
  if (!import.meta.env.DEV) return null; // dev/test-only hook
  if (override) return override;
  try {
    const v = (window as unknown as { __connectivityOverride?: unknown }).__connectivityOverride;
    return v === 'online' || v === 'offline' ? (v as Connectivity) : null;
  } catch {
    return null;
  }
}

/** The state we should be in right now: override, else navigator.onLine. */
function desiredState(): Connectivity {
  return currentOverride() ?? (navigator.onLine ? 'online' : 'offline');
}

/** Pin connectivity for tests/embedders; pass null to return control to the browser. */
export function setConnectivityOverride(next: Connectivity | null): void {
  if (!import.meta.env.DEV) return; // dev/test-only hook
  override = next;
  dbg(`conn|override=${String(next)}`);
  // Re-evaluate immediately so callers see the change without waiting for a
  // window event.
  setState(desiredState());
}

export function clearConnectivityOverride(): void {
  if (!import.meta.env.DEV) return; // dev/test-only hook
  setConnectivityOverride(null);
}

/** Start connectivity monitoring. Call once on app boot. */
export function startConnectivityMonitor(): void {
  if (started) return;
  started = true;

  // Initialize from navigator.onLine (or an override) — never a hardcoded
  // default — and notify subscribers so late-attaching UI can sync up.
  setState(desiredState(), true);

  // From here on, the browser's own signals drive the state: 'offline' means
  // the machine lost its network; 'online' is re-checked against
  // navigator.onLine in case the event was synthetic.
  window.addEventListener('offline', () => {
    dbg('conn|window offline event');
    setState(currentOverride() ?? 'offline');
  });
  window.addEventListener('online', () => {
    dbg(`conn|window online event navOnline=${navigator.onLine}`);
    setState(currentOverride() ?? (navigator.onLine ? 'online' : 'offline'));
  });

  dbg(`conn|monitor started navOnline=${navigator.onLine} state=${state}`);
}
