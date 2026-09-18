// Pure, DOM-free op application.
//
// Extracted verbatim from src/client/offline/sync.ts so BOTH the main-thread
// sync engine and the background drain worker (a module Web Worker, which must
// never touch window/DOM) can share identical op-merging semantics. This module
// may only import types — no state, no connectivity, no database.
import type { ExcalidrawElement } from '../../types/elements';
import type { OfflineOp } from '../../types/offline';

/**
 * Merge a single offline op into an in-place element list, mirroring the
 * server's upsert semantics: updates overwrite by element id (the newer
 * element object wins wholesale), deletes mark the existing element deleted.
 */
export function applyOpToElements(elements: ExcalidrawElement[], op: OfflineOp): void {
  const map = new Map(elements.map(e => [e.id, e]));
  if (op.type === 'element-update') {
    for (const el of op.elements) map.set(el.id, el);
  } else if (op.type === 'element-delete') {
    for (const id of op.elementIds) {
      const existing = map.get(id);
      if (existing) map.set(id, { ...existing, isDeleted: true });
    }
  }
  elements.length = 0;
  elements.push(...map.values());
}