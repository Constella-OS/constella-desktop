/**
 * Typed main-side facade over the db worker — what file-index, file-graph and
 * the MCP bridge import instead of doing IPC round-trips to the renderer.
 *
 * Every function is a thin promise wrapper over callRepo(); docs go in/out as
 * raw JSON strings (DocString). If the backend ever moves from a
 * worker_thread to a utilityProcess, only ./db.ts changes — these signatures
 * (and their callers) stay put.
 */
import type { DocString } from '../../shared/main-db-api';
import { callRepo } from './db';

// --- notes ------------------------------------------------------------------
export const notesFindByIds = (ids: string[]) =>
  callRepo<DocString[]>('notes', 'findByIds', [ids]);

export const notesFindOne = (id: string) =>
  callRepo<DocString | null>('notes', 'findOne', [id]);

export const notesFindIdsByIntegration = (names: string[]) =>
  callRepo<string[]>('notes', 'findIdsByIntegration', [names]);

export const notesPage = (afterId: string, limit = 2000) =>
  callRepo<DocString[]>('notes', 'page', [{ afterId, limit }]);

/** Newest-first notes (optionally filtered to `noteTypes`) for time-ordered
 *  surfaces — the MCP `recent_notes` tool. */
export const notesRecent = (opts: { limit?: number; noteTypes?: string[] }) =>
  callRepo<DocString[]>('notes', 'recent', [opts]);

/** Newest notes carrying any of `tagIds` — the tag leg of search_local_notes. */
export const notesRecentByTags = (opts: { tagIds: string[]; limit?: number }) =>
  callRepo<DocString[]>('notes', 'recentByTags', [opts]);

// --- tags ---------------------------------------------------------------------
/** Every tag doc the user has (the full tag vocabulary) — the MCP `list_tags`
 *  tool. Local-first sqlite source, same table the renderer's tag pickers read. */
export const tagsFindAll = () => callRepo<DocString[]>('tags', 'findAll');

export const notesBulkUpsert = (docs: DocString[]) =>
  callRepo<{ count: number }>('notes', 'bulkUpsert', [docs]);

export const notesBulkInsertIgnore = (docs: DocString[]) =>
  callRepo<{ inserted: number }>('notes', 'bulkInsertIgnore', [docs]);

export const notesBulkRemove = (ids: string[]) =>
  callRepo<DocString[]>('notes', 'bulkRemove', [ids]);

export const notesCount = () => callRepo<number>('notes', 'count');

// --- note bodies --------------------------------------------------------------
export const noteBodiesFindByIds = (ids: string[]) =>
  callRepo<DocString[]>('noteBodies', 'findByIds', [ids]);

export const noteBodiesBulkUpsert = (docs: DocString[]) =>
  callRepo<{ count: number }>('noteBodies', 'bulkUpsert', [docs]);

export const noteBodiesBulkRemove = (ids: string[]) =>
  callRepo<DocString[]>('noteBodies', 'bulkRemove', [ids]);

export const noteBodiesFindIdsByReference = (referenceId: string) =>
  callRepo<string[]>('noteBodies', 'findIdsByReference', [referenceId]);

export const noteBodiesCount = () => callRepo<number>('noteBodies', 'count');

// --- canvases -----------------------------------------------------------------
/** Compact scalar row (no doc) — see repos/canvases.js findMetaByIds/recent. */
export interface CanvasMetaRow {
  uniqueid: string;
  name: string;
  description: string | null;
  node_count: number;
  card_theme_color: string | null;
  card_emoji: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** JSON string of {id,type,title}[] */
  preview_nodes: string | null;
}

export const canvasesFindOne = (id: string) =>
  callRepo<DocString | null>('canvases', 'findOne', [id]);

export const canvasesFindMetaByIds = (ids: string[]) =>
  callRepo<CanvasMetaRow[]>('canvases', 'findMetaByIds', [ids]);

export const canvasesCount = () => callRepo<number>('canvases', 'count');

// --- meta ---------------------------------------------------------------------
export const metaGet = (key: string) =>
  callRepo<string | null>('meta', 'get', [key]);

export const metaSet = (key: string, value: string) =>
  callRepo<null>('meta', 'set', [{ key, value }]);
