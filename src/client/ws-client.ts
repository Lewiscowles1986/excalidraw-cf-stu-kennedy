import type { ExcalidrawElement } from './types';
import type { ClientMessage, ServerMessage } from '../types/protocol';
import { store } from './state';
import { updateRemoteCursor, removeRemoteCursor } from './renderer';
import { enqueue, currentRevision, currentRoomId } from './offline';
import type { Connectivity } from './offline/connectivity';
import { isOnline, subscribeConnectivity } from './offline/connectivity';
import { getStableUserId } from './identity';

class WebSocketClient {
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private userId: string;
  private username: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private cursorThrottle = 0;

  constructor() {
    // Stable per-device identity (localStorage-backed): room attribution and
    // the "rooms you've edited" registry depend on the SAME userId surviving
    // reloads. Username stays per-run/cosmetic by design.
    this.userId = getStableUserId();
    this.username = `User ${Math.floor(Math.random() * 1000)}`;
    // WS lifecycle guardrails: react to connectivity transitions. The
    // subscription is permanent for this singleton; reconnecting is guarded on
    // roomId so it is a no-op without an active room.
    subscribeConnectivity((online) => this.onConnectivityChanged(online));
  }

  connect(roomId: string): void {
    this.roomId = roomId;
    store.setAppState({ roomId });

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/${roomId}?userId=${this.userId}&username=${encodeURIComponent(this.username)}`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      console.warn('[ws] WebSocket not available (dev mode?)');
      return;
    }

    // Capture the live socket so handlers ignore events from a stale socket
    // that has already been replaced (e.g. by a connectivity-driven reconnect).
    const socket = this.ws;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.reconnectDelay = 1000;
      this.reconnectAttempts = 0;
      this.send({ type: 'request-sync' });
      window.dispatchEvent(new CustomEvent('excalidraw:ws-status', { detail: { connected: true } }));
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      const msg = JSON.parse(event.data) as ServerMessage;
      this.handleMessage(msg);
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      window.dispatchEvent(new CustomEvent('excalidraw:ws-status', { detail: { connected: false } }));
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // Silently close - onclose will handle reconnect. Only touch the live
      // socket; an error on a stale socket must not kill its replacement.
      if (this.ws === socket) socket.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    // The connectivity subscription stays (permanent singleton); every action
    // it takes is guarded on this.roomId, so it no-ops once disconnected.
  }

  /**
   * WS lifecycle guardrails, driven by connectivity transitions:
   * - → offline: only hard-teardown when the network is provably dead
   *   (navigator.onLine === false). If the machine still reports online, leave
   *   the socket alone — a single failed request is not evidence of a dead
   *   network.
   * - → online: the backoff chain (1s→16s, 5 attempts) may already be
   *   exhausted after a long offline period, so reset it and reconnect
   *   immediately instead of waiting for a manual connect() call.
   */
  onConnectivityChanged(state: Connectivity): void {
    if (state !== 'online') {
      if (navigator.onLine === false && this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        console.warn('[ws] navigator.onLine=false — closing socket (provably dead network)');
        this.ws.close();
      }
      return;
    }
    const rs = this.ws?.readyState;
    const dead = !this.ws || rs === WebSocket.CLOSED || rs === WebSocket.CLOSING;
    if (this.roomId && dead) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      console.warn(`[ws] Back online — reconnecting to room ${this.roomId}`);
      this.connect(this.roomId);
    }
  }

  private scheduleReconnect(): void {
    if (!this.roomId) return;
    // While the machine is provably offline, retrying is pointless: every
    // attempt would fail. Going back online resets the backoff and reconnects
    // (see onConnectivityChanged).
    if (!isOnline()) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[ws] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Use wsClient.connect() to retry.`);
      return;
    }
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.roomId) this.connect(this.roomId);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'full-sync':
        store.updateElements(msg.elements);
        break;
      case 'element-update':
        if (msg.senderId !== this.userId && msg.senderId !== 'offline-sync') {
          store.updateElements(msg.elements);
        }
        break;
      case 'element-delete':
        if (msg.senderId !== this.userId && msg.senderId !== 'offline-sync') {
          for (const id of msg.elementIds) {
            store.deleteElement(id);
          }
        }
        break;
      case 'cursor-move':
        if (msg.userId !== this.userId) {
          updateRemoteCursor(msg.userId, msg.x, msg.y, msg.username);
        }
        break;
      case 'user-joined':
        window.dispatchEvent(new CustomEvent('excalidraw:user-joined', { detail: msg }));
        break;
      case 'user-left':
        removeRemoteCursor(msg.userId);
        window.dispatchEvent(new CustomEvent('excalidraw:user-left', { detail: msg }));
        break;
      case 'pong':
        break;
    }
  }

  sendElementUpdate(elements: ExcalidrawElement[]): void {
    // Always persist to the local copy first (offline-first write path).
    if (this.roomId) {
      void enqueue(this.roomId, { type: 'element-update', elements }, currentRevision());
    }
    // When the socket is live, also send immediately.
    if (this.isConnected()) {
      this.send({ type: 'element-update', elements });
    }
  }

  sendElementDelete(elementIds: string[]): void {
    if (this.roomId) {
      void enqueue(this.roomId, { type: 'element-delete', elementIds }, currentRevision());
    }
    if (this.isConnected()) {
      this.send({ type: 'element-delete', elementIds });
    }
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingElements: Map<string, ExcalidrawElement> = new Map();

  // Legacy HTTP fallback kept for the flush-all periodic backup path. It is
  // only safe while we are actually online; offline edits flow through the
  // IndexedDB outbox instead, so nothing is dropped.
  private saveViaHttp(elements: ExcalidrawElement[]): void {
    if (!isOnline()) return;
    for (const el of elements) {
      this.pendingElements.set(el.id, el);
    }
    // Debounce saves to avoid flooding
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const toSave = Array.from(this.pendingElements.values());
      this.pendingElements.clear();
      if (toSave.length > 0 && this.roomId) {
        fetch(`/api/rooms/${this.roomId}/elements`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': this.userId },
          body: JSON.stringify(toSave),
        }).catch(() => {});
      }
    }, 500);
  }

  sendCursorMove(x: number, y: number): void {
    const now = Date.now();
    if (now - this.cursorThrottle < 50) return; // Throttle to 20fps
    this.cursorThrottle = now;
    this.send({ type: 'cursor-move', userId: this.userId, x, y, username: this.username });
  }

  /** Flush all current elements to the DO via HTTP - used as periodic backup */
  flushAll(): void {
    if (!this.roomId || !isOnline()) return;
    const elements = Array.from(store.elements.values());
    if (elements.length > 0) {
      fetch(`/api/rooms/${this.roomId}/elements`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': this.userId },
        body: JSON.stringify(elements),
      }).catch(() => {});
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getUserId(): string { return this.userId; }
  getUsername(): string { return this.username; }
  setUsername(name: string): void { this.username = name; }
}

export const wsClient = new WebSocketClient();
