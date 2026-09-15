// Connectivity detection.
//
// The browser's `online`/`offline` events only tell us whether the machine is
// connected to *a* network — the app can still be unreachable (e.g. Cloudflare
// is down, or a login session expired). So we treat the app as offline unless
// BOTH the browser reports online AND a `/api/ping` probe succeeds.
//
// Default is OFFLINE, per the brief: we optimistically assume we may be without
// a backend until proven otherwise.

export type Connectivity = 'online' | 'offline';

type Listener = (state: Connectivity) => void;

const PING_URL = '/api/ping';
const PROBE_MS = 10_000; // re-probe every 10s while we think we're offline
const ONLINE_MS = 30_000; // confirm again every 30s while online

let state: Connectivity = 'offline';
const listeners = new Set<Listener>();

export function isOnline(): boolean {
  return state === 'online';
}

export function subscribeConnectivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(next: Connectivity): void {
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn(state);
  window.dispatchEvent(new CustomEvent('excalidraw:connectivity', { detail: { online: state === 'online' } }));
}

async function probeOnce(): Promise<void> {
  // If the machine itself is offline, skip the network probe.
  if (!navigator.onLine) {
    setState('offline');
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(PING_URL, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    setState(res.ok ? 'online' : 'offline');
  } catch {
    setState('offline');
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleProbe(): void {
  if (timer) clearTimeout(timer);
  const delay = state === 'online' ? ONLINE_MS : PROBE_MS;
  timer = setTimeout(async () => {
    await probeOnce();
    scheduleProbe();
  }, delay);
}

/** Start connectivity monitoring. Call once on app boot. */
export function startConnectivityMonitor(): void {
  // Always start believing we are offline unless we can prove otherwise.
  setState('offline');

  window.addEventListener('online', () => probeOnce());
  window.addEventListener('offline', () => setState('offline'));

  probeOnce();
  scheduleProbe();
}
