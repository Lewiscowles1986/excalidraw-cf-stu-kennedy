import type { OfflineRoom, OfflineOp } from '../types/offline';

const DB_NAME = 'excalidraw-cf-offline';
const DB_VERSION = 1;
const ROOMS = 'rooms';
const EVENTS = 'events';

// Row in the 'events' object store: an append-only operation log per room.
// `seq` is a monotonically increasing key used to keep global ordering.
interface EventRow {
  seq: number;
  roomId: string;
  op: OfflineOp;
  createdAt: number;
  // local revision at the time the op was enqueued (the "last-row")
  baseRevision: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOMS)) {
        db.createObjectStore(ROOMS, { keyPath: 'roomId' });
      }
      if (!db.objectStoreNames.contains(EVENTS)) {
        const store = db.createObjectStore(EVENTS, { keyPath: 'seq', autoIncrement: true });
        store.createIndex('roomId', 'roomId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | IDBRequest<T>[],
): Promise<T> {
  return openDB().then((db) =>
    new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let storeRequests: IDBRequest<T> | IDBRequest<T>[];
      try {
        storeRequests = fn(transaction.objectStore(storeName));
      } catch (e) {
        reject(e);
        return;
      }
      const all = Array.isArray(storeRequests) ? storeRequests : [storeRequests];
      const results: unknown[] = [];
      all.forEach((r, i) => {
        r.onsuccess = () => { results[i] = r.result; };
        r.onerror = () => reject(r.error);
      });
      transaction.oncomplete = () => resolve(results.length === 1 ? results[0] as T : results as unknown as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }),
  );
}

export const db = {
  /** Save (insert or overwrite) a room snapshot. */
  async saveRoom(room: OfflineRoom): Promise<void> {
    await tx(ROOMS, 'readwrite', (s) => s.put(room));
  },

  /** Delete a room and all its queued events. Used when forking. */
  async deleteRoom(roomId: string): Promise<void> {
    await tx(ROOMS, 'readwrite', (s) => s.delete(roomId));
    // Remove events for this room
    const dbh = await openDB();
    const txw = dbh.transaction(EVENTS, 'readwrite');
    const store = txw.objectStore(EVENTS);
    const idx = store.index('roomId');
    const req = idx.openKeyCursor(IDBKeyRange.only(roomId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    await new Promise<void>((resolve, reject) => {
      txw.oncomplete = () => resolve();
      txw.onerror = () => reject(txw.error);
      txw.onabort = () => reject(txw.error);
    });
  },

  /** Load a room snapshot by id, or undefined. */
  async getRoom(roomId: string): Promise<OfflineRoom | undefined> {
    return tx<OfflineRoom | undefined>(ROOMS, 'readonly', (s) => s.get(roomId));
  },

  /** Append an offline op to a room's log. Returns the new seq. */
  async appendEvent(roomId: string, op: OfflineOp, baseRevision: number): Promise<number> {
    const row: EventRow = { roomId, op, baseRevision, createdAt: Date.now(), seq: 0 };
    const putReq = tx<number>(EVENTS, 'readwrite', (s) => s.add(row) as IDBRequest<number>);
    // add resolves to the generated key
    return putReq.then((k) => k as number);
  },

  /** Load every queued event for a room, oldest first. */
  async getEvents(roomId: string): Promise<EventRow[]> {
    const rows = await tx<EventRow[]>(EVENTS, 'readonly', (s) => {
      const idx = s.index('roomId');
      const range = IDBKeyRange.only(roomId);
      const req = idx.openCursor(range);
      return new Promise((resolve, reject) => {
        const out: EventRow[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            out.push(cursor.value);
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
    return rows.sort((a, b) => a.seq - b.seq);
  },

  /** Remove events whose seq is in the given list (after successful sync). */
  async removeEvents(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    const dbh = await openDB();
    const txw = dbh.transaction(EVENTS, 'readwrite');
    const store = txw.objectStore(EVENTS);
    for (const seq of seqs) store.delete(seq);
    await new Promise<void>((resolve, reject) => {
      txw.oncomplete = () => resolve();
      txw.onerror = () => reject(txw.error);
      txw.onabort = () => reject(txw.error);
    });
  },

  /** List all known room ids. */
  async listRooms(): Promise<string[]> {
    const rows = await tx<{ roomId: string }[]>(ROOMS, 'readonly', (s) => {
      const req = s.getAll();
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as { roomId: string }[]);
        req.onerror = () => reject(req.error);
      });
    });
    return rows.map(r => r.roomId);
  },
};
