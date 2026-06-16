/**
 * Doc text accessors — thin shim over the SQLite graph store (graphDb `docs`
 * table). Keeps the original function surface so callers (connections, extract,
 * backfill, synthesize) don't change. Written during file-index extraction so
 * the main-process engine has the text the renderer's RxDB holds.
 */
import {
  putDoc,
  getDoc,
  hasDoc,
  allDocIds,
  deleteDocsByParentIds,
  type GraphDoc,
} from './graphDb';
import { MAX_STORED_TEXT } from './constants';

export type { GraphDoc };

export async function putGraphDoc(doc: GraphDoc): Promise<void> {
  try {
    putDoc({ ...doc, text: (doc.text ?? '').slice(0, MAX_STORED_TEXT) });
  } catch {
    /* best-effort */
  }
}

export async function getGraphDoc(parentId: string): Promise<GraphDoc | null> {
  try {
    return getDoc(parentId);
  } catch {
    return null;
  }
}

export function hasGraphDocSync(parentId: string): boolean {
  try {
    return hasDoc(parentId);
  } catch {
    return false;
  }
}

export async function listParentIds(): Promise<string[]> {
  try {
    return allDocIds();
  } catch {
    return [];
  }
}

/** Remove deleted notes' docs/processed/edges so reconcile can't resurrect them. */
export async function removeGraphDocs(parentIds: string[]): Promise<void> {
  try {
    deleteDocsByParentIds(parentIds);
  } catch {
    /* best-effort */
  }
}
