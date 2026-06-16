/**
 * Note-store reconcile (main process) — recovers from a divergence where the
 * file index (LanceDB vectors + manifest + graph `docs` text store) is
 * populated but the main DB has lost the matching note rows.
 *
 * Why this exists: `syncService` only writes records for CHANGED files
 * (manifest mtime/size diff). Once the manifest lists a file, it's never
 * re-written — so if the note store is wiped/reset, those notes are gone for
 * good and recall returns vectors that hydrate to nothing.
 *
 * The fix: the graph `docs` table already stores every indexed file's text
 * (title/path/text), so we can rebuild the note rows from it CHEAPLY — no
 * re-extracting PDFs, no re-embedding. With note storage in main, we diff
 * against the sqlite store directly (the renderer's haveIds handshake is
 * obsolete) and INSERT OR IGNORE the missing rows; the records are still
 * emitted so the renderer's minisearch picks them up.
 */
import path from 'path';
import { listParentIds, getGraphDoc } from '../file-graph/textStore';
import { noteTypeForExtension } from './extractors';
import { notesBulkInsertIgnore, notesFindIdsByIntegration } from '../main-db/api';

const RECONCILE_BATCH = 50;

// Same emit bridge syncService uses (lazy require avoids a main.ts cycle).
function emit(channel: string, payload: any): void {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { mainWindow } = require('../main');
    mainWindow?.webContents?.send(channel, payload);
  } catch {
    /* window gone / not ready */
  }
}

// Rebuild a NoteRxdbData-shaped object from a stored graph doc. Mirrors
// buildFileRecords' parent-note shape (PDFs keep text in fileText, content
// empty; plain text lives in content). Vector is empty — RxDB's note.vector is
// not used for search (LanceDB owns vectors); recall hydrates parents by id.
function noteFromDoc(doc: {
  parentId: string;
  title: string;
  path: string;
  text: string;
}): Record<string, any> {
  const absPath = doc.path || '';
  const fileName = absPath ? path.basename(absPath) : '';
  const isDoc = absPath ? noteTypeForExtension(absPath) === 'pdf' : false;
  const now = Date.now();
  return {
    uniqueid: doc.parentId,
    title: (doc.title || fileName || 'Untitled').replace(/\.[^.]+$/, ''),
    content: isDoc ? '' : doc.text || '',
    vector: [],
    filePath: absPath,
    tags: [],
    created: now,
    lastModified: now,
    incomingConnections: [],
    outgoingConnections: [],
    incomingConnectionsV2: [],
    outgoingConnectionsV2: [],
    noteType: isDoc ? 'pdf' : 'text',
    fileText: isDoc ? doc.text || '' : '',
    fileName,
    fileSummary: '',
    integrationName: 'local',
    subtype: 'local_file',
  };
}

/**
 * Rebuild the note row for every indexed doc missing from the main DB.
 * The legacy `haveIds` param (renderer-supplied) is ignored — main reads the
 * authoritative id set from sqlite itself. Returns how many notes were
 * restored. Cheap: reads the already-stored doc text, no extraction or
 * embedding. INSERT OR IGNORE so a concurrent live write is never clobbered.
 */
export async function reconcileRxdbFromDocs(
  _haveIds: string[] = [],
): Promise<{ reemitted: number; total: number }> {
  let allIds: string[] = [];
  try {
    allIds = await listParentIds();
  } catch {
    return { reemitted: 0, total: 0 };
  }
  let have: Set<string>;
  try {
    have = new Set(
      await notesFindIdsByIntegration(['local', 'obsidian', 'demo']),
    );
  } catch (e) {
    console.warn('[file-index] reconcile: main-db id read failed', e);
    return { reemitted: 0, total: allIds.length };
  }
  const missing = allIds.filter((id) => id && !have.has(id));
  if (missing.length === 0) return { reemitted: 0, total: allIds.length };

  let batch: Record<string, any>[] = [];
  let reemitted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const notes = batch;
    batch = [];
    try {
      await notesBulkInsertIgnore(notes.map((n) => JSON.stringify(n)));
    } catch (e: any) {
      console.warn('[file-index] reconcile main-db write failed:', e?.message ?? e);
      return;
    }
    // Emit so the renderer's minisearch indexes the restored notes.
    emit('file-index:records', {
      sourceId: 'reconcile',
      notes,
      noteBodies: [],
    });
    reemitted += notes.length;
  };

  for (const id of missing) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await getGraphDoc(id);
    if (!doc || !doc.parentId) continue;
    batch.push(noteFromDoc(doc));
    // eslint-disable-next-line no-await-in-loop
    if (batch.length >= RECONCILE_BATCH) await flush();
  }
  await flush();

  // eslint-disable-next-line no-console
  console.log(
    `[file-index] reconcile: restored ${reemitted} note(s) missing from the main db (of ${allIds.length} indexed docs)`,
  );
  return { reemitted, total: allIds.length };
}
