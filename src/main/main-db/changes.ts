/**
 * db:changed broadcast — tells every renderer window that rows in a main-DB
 * collection changed, so UI-side caches (minisearch, Zustand lists) can react.
 *
 * `origin` carries the webContents.id of the renderer that requested the
 * write; that renderer ignores its own echo. Main-side writers (file-index,
 * file-graph, migration) use origin -1 so every window reacts.
 */
import { BrowserWindow } from 'electron';

import type { DbChangedEvent } from '../../shared/main-db-api';
import { DB_CHANGED_CHANNEL } from '../../shared/main-db-api';

type DbChangedListener = (event: DbChangedEvent) => void;
const listeners = new Set<DbChangedListener>();

/**
 * Main-process subscription to committed writes — fires for EVERY write
 * (renderer-originated and main-side alike), before the renderer broadcast.
 * Used by the file-graph note ingest to pick up app-created notes. Returns an
 * unsubscribe function. Listeners must never throw into the write path.
 */
export function onDbChanged(listener: DbChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitDbChanged(event: DbChangedEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error('[main-db] db-changed listener failed:', e);
    }
  }
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(DB_CHANGED_CHANNEL, event);
      }
    }
  } catch (e) {
    console.error('[main-db] failed to broadcast db:changed:', e);
  }
}
