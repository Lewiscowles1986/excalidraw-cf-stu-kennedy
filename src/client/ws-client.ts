import type { ExcalidrawElement } from './types';
import type { ClientMessage, ServerMessage } from '../types/protocol';
import { store } from './state';
import { updateRemoteCursor, removeRemoteCursor } from './renderer';
import { enqueue, currentRevision, currentRoomId } from './offline';
import { isOnline } from './offline/connectivity';

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
    this.userId = crypto.randomUUID();
    this.username = `User ${Math.floor(Math.random() * 1000)}`;
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

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.reconnectAttempts = 0;
      this.send({ type: 'request-sync' });
      window.dispatchEvent(new CustomEvent('excalidraw:ws-status', { detail: { connected: true } }));
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage;
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      window.dispatchEvent(new CustomEvent('excalidraw:ws-status', { detail: { connected: false } }));
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // Silently close - onclose will handle reconnect
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (!this.roomId) return;
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
          headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
