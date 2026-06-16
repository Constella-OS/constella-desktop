/**
 * Note → graph ingest: makes app-created notes (capture-overlay thoughts,
 * canvas notes, ingested links — anything the renderer writes into the main-DB
 * `notes` table) first-class citizens of the knowledge-graph engine, exactly
 * like file-indexed records:
 *
 *   db write committed → debounce per note → fetch doc → store text in the
 *   graph text store (graphDb.docs) → embed title+content (EmbeddingGemma,
 *   document mode) → upsert the parent vector into LanceDB (nodeType 'note') →
 *   chunk the body into 'note_body' rows (db.noteBodies + LanceDB) → nudge the
 *   scheduler, whose next connection pass picks the note up.
 *
 * Body chunking mirrors the cloud's content-hashed rechunk (see
 * notes_processing.sync_note_chunks_for_parent): each chunk's id is a hash of
 * (parentId, chunkText), so on an edit unchanged paragraphs keep their id +
 * vector (no re-embed), removed paragraphs are purged, and only new/edited
 * paragraphs are embedded. Local edges live at the PARENT level (chunks are just
 * extra retrieval candidates that resolve back to their parent via relatedIds),
 * so — unlike the cloud — there's no chunk-level edge migration. A real body
 * edit clears the parent's processed marker so the next connection pass
 * recomputes its outgoing edges against the refreshed evidence.
 *
 * Skips records that already have their own pipeline (file-index / Obsidian /
 * integration records carry integrationName/subtype) and AI-generated nodes
 * (connecting model output back into the graph is the same feedback loop the
 * concept/theme nodeType exclusion guards against). Deletes purge the doc,
 * processed marker, edges, parent + chunk LanceDB rows, and chunk bodies so
 * reconcile can't resurrect them.
 *
 * State: per-note debounce timers, a serial ingest chain (so we never hammer
 * the shared embed worker in parallel with the file indexer), and a per-note
 * attempt counter for retrying when the embedder isn't up yet.
 */
import { v5 as uuidv5 } from 'uuid';
import type { DbChangedEvent } from '../../shared/main-db-api';
import { onDbChanged } from '../main-db/changes';
import {
  notesFindByIds,
  noteBodiesBulkUpsert,
  noteBodiesBulkRemove,
  noteBodiesFindIdsByReference,
} from '../main-db/api';
import { embedDocument } from '../ai/create-embedding';
import { chunkDocument } from '../file-index/chunker';
import {
  updateLanceDB,
  removeMultipleFromLanceDB,
} from '../utils/vector-db/vector-db';
import { putGraphDoc, getGraphDoc, removeGraphDocs } from './textStore';
import { clearProcessed } from './edgeStore';
import { notifyNewChunks } from './scheduler';
import { MAX_STORED_TEXT } from './constants';

// AI-generated canvas nodes — never ingested (model output feeding the
// connection LLM is recall pollution, mirroring the concept/theme exclusion).
const SKIPPED_NOTE_TYPES = new Set(['aiNode', 'ai_chat_output']);
// Wait for the user to stop typing/patching before re-ingesting a note.
const DEBOUNCE_MS = 4_000;
// Below this much text a note can't produce meaningful queries or candidates.
const MIN_TEXT_CHARS = 20;
// Embedding input cap — EmbeddingGemma's window is small; the full text still
// goes to the text store (which has its own MAX_STORED_TEXT cap).
const EMBED_TEXT_CHARS = 4_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30_000;
// Distinct namespace so note-chunk ids never collide with the file-index's
// positional chunk ids (records.ts uses its own namespace). Clean uuid (no
// `__`) — note-logic's parseVectorDBSearchResults dedups on `uniqueid.split('__')[0]`.
const NOTE_CHUNK_NAMESPACE = 'a2f5c9d1-6e3b-4c8a-9f70-2d1e4b6a8c30';

/** Content-hashed chunk id: identical paragraph text under the same parent →
 *  identical id, so unchanged chunks survive edits (kept, not re-embedded). */
function noteChunkId(parentId: string, text: string): string {
  return uuidv5(`notechunk:${parentId}:${text}`, NOTE_CHUNK_NAMESPACE);
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const attempts = new Map<string, number>();
// Serial chain: one note embeds at a time so boot migrations / paste bursts
// queue up instead of stampeding the embed worker.
let chain: Promise<void> = Promise.resolve();
let started = false;

/** Cheap HTML → plain text (note content is Tiptap HTML on canvas paths).
 *  Exported for the integration relay, which gets HTML bodies from the cloud. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Bring a note's body chunks in line with its current text — the local mirror
 * of the cloud's content-hashed rechunk. Returns true when any chunk was added
 * or removed (so the caller can nudge the scheduler).
 *
 * Each desired chunk is keyed by noteChunkId(parent, text); diffing that set
 * against the parent's existing chunk ids gives:
 *   - toAdd    → embed (document mode) + write note_body row + LanceDB vector
 *   - toRemove → delete note_body row + LanceDB vector
 *   - surviving (intersection) → left untouched (no re-embed)
 * Short bodies (chunkDocument returns []) clear any stale chunks and stop — the
 * parent vector alone covers them. Embed failure throws so the caller's retry
 * re-runs the whole note; we embed everything before persisting anything, so an
 * outage never leaves a half-written chunk set.
 */
async function syncNoteChunks(
  parentId: string,
  body: string,
  title: string,
  lastModified: number,
): Promise<boolean> {
  // Desired final state. Content-hashed ids dedupe identical paragraphs.
  const desired = new Map<string, { text: string; index: number }>();
  for (const c of chunkDocument(body)) {
    const cid = noteChunkId(parentId, c.text);
    if (!desired.has(cid)) desired.set(cid, { text: c.text, index: c.index });
  }

  const existingIds = await noteBodiesFindIdsByReference(parentId);
  const existing = new Set(existingIds);
  const toRemove = existingIds.filter((cid) => !desired.has(cid));
  const toAdd = [...desired.entries()].filter(([cid]) => !existing.has(cid));

  // Embed every new chunk BEFORE writing anything (atomic-ish: an embedder
  // outage leaves no partial chunk set — the retry re-runs the whole note).
  const pending: Array<{ cid: string; vec: number[]; doc: string }> = [];
  for (const [cid, c] of toAdd) {
    const vec = await embedDocument(c.text);
    if (!vec || !(vec as ArrayLike<number>).length) {
      throw new Error('local embedder unavailable (chunk)');
    }
    pending.push({
      cid,
      vec: Array.from(vec as ArrayLike<number>),
      // NoteBodyRxdbData shape (vector stripped on write — LanceDB owns it).
      doc: JSON.stringify({
        uniqueid: cid,
        text: c.text,
        vector: [],
        referenceId: parentId,
        type: 'note',
        created: lastModified,
        lastModified,
        position: c.index,
        referenceTitle: title,
        outgoingConnections: [],
        incomingConnectionsV2: [],
        outgoingConnectionsV2: [],
      }),
    });
  }

  if (pending.length) {
    await noteBodiesBulkUpsert(pending.map((p) => p.doc));
    for (const p of pending) {
      // relatedIds: [0]=parent (file-graph resolves chunk→parent via this),
      // [1]=own body id (note-logic recall hydration looks it up in noteBodies).
      await updateLanceDB(p.cid, p.vec, 'note_body', [parentId, p.cid]);
    }
  }
  if (toRemove.length) {
    await noteBodiesBulkRemove(toRemove);
    await removeMultipleFromLanceDB(toRemove);
  }

  if (toAdd.length || toRemove.length) {
    console.log(
      `[file-graph:note-ingest] chunks "${title.slice(0, 40)}" +${toAdd.length}/-${toRemove.length} (${desired.size} total)`,
    );
    return true;
  }
  return false;
}

/**
 * Ingest one note id into the graph engine: store its text, embed it, upsert
 * the LanceDB row, and reconcile its body chunks. Throws when the embedder is
 * unavailable so the caller's retry path kicks in; silently returns for records
 * that shouldn't be in the graph (file-index/integration/AI records, too-short
 * notes).
 */
async function ingestNote(id: string): Promise<void> {
  const [docStr] = await notesFindByIds([id]);
  if (!docStr) return; // deleted between the write and the debounce firing
  let doc: any;
  try {
    doc = JSON.parse(docStr);
  } catch {
    return;
  }
  // File-index / Obsidian / integration records already flow through the
  // file-index pipeline (chunking + embedding + putGraphDoc in syncService).
  if (doc.integrationName || doc.subtype) return;
  if (doc.noteType && SKIPPED_NOTE_TYPES.has(doc.noteType)) return;

  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  const body = htmlToPlain(typeof doc.content === 'string' ? doc.content : '');
  const text = [title, body].filter(Boolean).join('\n\n').trim();
  if (text.length < MIN_TEXT_CHARS) return;
  const lastModified =
    typeof doc.lastModified === 'number' ? doc.lastModified : Date.now();

  // Tag/connection/position patches re-emit db:changed without touching the
  // text — compare against the stored doc so those don't burn an embedding on
  // the parent. (We still reconcile chunks below: it's a cheap no-op when they
  // already match, and it backfills notes ingested before chunking existed.)
  const stored = await getGraphDoc(id);
  const capped = text.slice(0, MAX_STORED_TEXT);
  const textChanged = !(
    stored &&
    stored.title === title &&
    stored.text === capped
  );

  if (textChanged) {
    await putGraphDoc({ parentId: id, title, path: '', text });
    const vec = await embedDocument(text.slice(0, EMBED_TEXT_CHARS), title);
    if (!vec || !(vec as ArrayLike<number>).length) {
      // Local model not loaded (yet) — text is stored, but without a vector the
      // note can't surface as a connection candidate. Retry via the caller.
      throw new Error('local embedder unavailable');
    }
    // mergeInsert: creates the row on first capture, refreshes it on edits.
    await updateLanceDB(id, Array.from(vec as ArrayLike<number>), 'note', []);
  }

  // Reconcile the body chunks (incremental: only new/edited paragraphs embed).
  const chunksChanged = await syncNoteChunks(id, body, title, lastModified);

  // A real body edit invalidates the note's neighborhood — re-arm it for the
  // connection pass so its outgoing edges get recomputed (mirrors the cloud
  // dispatching graph enrichment after a rechunk).
  if (textChanged) clearProcessed(id);

  attempts.delete(id);
  if (textChanged || chunksChanged) {
    notifyNewChunks(1);
    console.log(
      `[file-graph:note-ingest] ingested "${title.slice(0, 60)}" (${id})`,
    );
  }
}

/** Append one note to the serial chain; schedule a backoff retry on failure. */
function enqueue(id: string): void {
  chain = chain
    .then(() => ingestNote(id))
    .catch((e: any) => {
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      if (n < MAX_ATTEMPTS) {
        console.warn(
          `[file-graph:note-ingest] ${id} failed (attempt ${n}): ${e?.message ?? e} — retrying in ${(RETRY_DELAY_MS * n) / 1000}s`,
        );
        schedule(id, RETRY_DELAY_MS * n);
      } else {
        attempts.delete(id);
        console.warn(`[file-graph:note-ingest] ${id} gave up: ${e?.message ?? e}`);
      }
    });
}

/** Debounce per note id — rapid edit patches collapse into one ingest. */
function schedule(id: string, delay: number = DEBOUNCE_MS): void {
  const existing = debounceTimers.get(id);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    id,
    setTimeout(() => {
      debounceTimers.delete(id);
      enqueue(id);
    }, delay),
  );
}

/** Purge every engine trace of deleted notes (idempotent for file notes,
 *  whose own pipeline also cleans up). */
function handleDelete(ids: string[]): void {
  for (const id of ids) {
    const t = debounceTimers.get(id);
    if (t) {
      clearTimeout(t);
      debounceTimers.delete(id);
    }
    attempts.delete(id);
  }
  // Fire-and-forget cleanups — each MUST swallow its own rejection, otherwise a
  // throw (e.g. graphDb/LanceDB locked mid-delete) becomes an unhandledRejection
  // that, without a process-level net, could silently kill the main process.
  removeGraphDocs(ids).catch((e: any) =>
    console.warn('[noteIngest] removeGraphDocs failed:', e?.message || e),
  );
  removeMultipleFromLanceDB(ids).catch((e: any) =>
    console.warn(
      '[noteIngest] removeMultipleFromLanceDB failed:',
      e?.message || e,
    ),
  );
  // Purge each parent's body chunks (note_body rows + their LanceDB vectors).
  void purgeNoteChunks(ids);
}

/** Remove the chunk rows + vectors belonging to deleted parent notes. */
async function purgeNoteChunks(parentIds: string[]): Promise<void> {
  try {
    const chunkIds: string[] = [];
    for (const pid of parentIds) {
      chunkIds.push(...(await noteBodiesFindIdsByReference(pid)));
    }
    if (!chunkIds.length) return;
    await noteBodiesBulkRemove(chunkIds);
    await removeMultipleFromLanceDB(chunkIds);
  } catch (e: any) {
    console.warn(
      `[file-graph:note-ingest] chunk purge failed: ${e?.message ?? e}`,
    );
  }
}

/**
 * Subscribe to main-DB writes and feed app-created notes into the graph
 * engine. Idempotent; called once at graph-engine boot (file-graph/ipc.ts).
 */
export function startNoteGraphIngest(): void {
  if (started) return;
  started = true;
  onDbChanged((event: DbChangedEvent) => {
    if (event.collection !== 'notes') return;
    if (event.op === 'delete') {
      handleDelete(event.ids);
      return;
    }
    for (const id of event.ids) schedule(id);
  });
  console.log('[file-graph:note-ingest] listening for note writes');
}
