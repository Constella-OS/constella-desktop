/**
 * Local-only note search, fully in the MAIN process.
 *
 * Built for the Chrome extension bridge: the extension runs its own cloud
 * search and merges client-side, so this deliberately searches ONLY local
 * data (LanceDB vectors + main-db SQLite hydration) — no cloud call, no
 * renderer round-trip. That means it answers whenever the Electron process
 * is alive, regardless of window/renderer state (unlike search_notes, which
 * bridges to the renderer).
 *
 * Pipeline: embedQuery (EmbeddingGemma, query template) → searchLanceDB
 * (deleted/graph-node filtering built in) → hydrate titles/snippets from
 * main-db (notes + note_bodies repos, see src/main/main-db/api.ts).
 *
 * LanceDB rows carry NO content ({uniqueid, vector, nodeType, deleted,
 * relatedIds} only); chunk rows point at their NoteBody via relatedIds[1]
 * and their parent note via relatedIds[0] (see file-index/records.ts).
 * Chunk hits are reported under the PARENT note id so get_note works on
 * every returned id.
 */
import { embedQuery } from '../ai/create-embedding';
import { getEmbeddingService } from '../ai/embedding/embedding-service';
import { isLanceDBReady, searchLanceDB } from '../utils/vector-db/vector-db';
import {
  notesFindByIds,
  noteBodiesFindByIds,
  canvasesFindMetaByIds,
  notesRecentByTags,
  tagsFindAll,
} from '../main-db/api';

export interface LocalSearchHit {
  id: string;
  title: string;
  snippet: string;
  type: string;
  score: number;
  lastModified?: number;
  /** how this hit entered the result: 'query' = vector match, 'tag' = pulled in
   *  by the tags filter (recent notes on those tags, no vector score). */
  via?: 'query' | 'tag';
}

export interface LocalSearchResult {
  /** 'warming' = embedding model or LanceDB not ready yet — retry later. */
  status: 'ok' | 'warming';
  hits: LocalSearchHit[];
}

// The agent feeds an already-expanded query set; we run each verbatim (no
// re-expansion), so allow the full set rather than the old 4-query cap.
const MAX_QUERIES = 12;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const SNIPPET_CHARS = 240;
const MAX_DISTANCE_AWAY = 0.5;
// How many recent notes to pull per tag-filtered request (folded into the
// combined list alongside the query hits).
const DEFAULT_TAG_NOTE_LIMIT = 30;
const MAX_TAG_NOTE_LIMIT = 100;

/** True when both legs (embedder + vector table) can serve a search now. */
export function isLocalSearchReady(): boolean {
  try {
    return isLanceDBReady() && getEmbeddingService().isReady();
  } catch {
    return false;
  }
}

function parseDoc(raw: string): Record<string, any> | null {
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

function toSnippet(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_CHARS);
}

interface RawHit {
  uniqueid: string;
  nodeType: string;
  score: number;
  relatedIds: string[];
}

/**
 * Pure-SQLite tag leg: resolve tag NAMES → ids (case-insensitive, via the tags
 * table) then pull the newest `limit` notes carrying any of them. No embedder /
 * LanceDB needed, so it answers even while the vector index is still warming.
 * Returns LocalSearchHits with via='tag' and score 0 (they're time-ranked, not
 * vector-scored). Parent notes only — the note_tags junction never holds chunks.
 */
async function fetchTagNotes(
  tagNames: string[],
  limit: number,
): Promise<LocalSearchHit[]> {
  const wanted = new Set(
    tagNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  if (!wanted.size) return [];

  const tagDocs = await tagsFindAll();
  const ids: string[] = [];
  for (const raw of tagDocs) {
    const doc = parseDoc(raw);
    const id = String(doc?.uniqueid ?? '').trim();
    const name = String(doc?.name ?? '').trim().toLowerCase();
    if (id && name && wanted.has(name)) ids.push(id);
  }
  if (!ids.length) {
    // eslint-disable-next-line no-console
    console.log(`[local-search] tags ${JSON.stringify([...wanted])} matched 0 tag ids`);
    return [];
  }

  const noteDocs = await notesRecentByTags({ tagIds: ids, limit });
  const hits: LocalSearchHit[] = [];
  for (const raw of noteDocs) {
    const doc = parseDoc(raw);
    if (!doc?.uniqueid) continue;
    hits.push({
      id: String(doc.uniqueid),
      title: String(doc.title || '').trim() || 'Untitled',
      snippet: toSnippet(doc.content || doc.fileText || doc.text),
      type: String(doc.noteType || 'note'),
      score: 0,
      ...(typeof doc.lastModified === 'number' ? { lastModified: doc.lastModified } : {}),
      via: 'tag',
    });
  }
  // eslint-disable-next-line no-console
  console.log(
    `[local-search] tags ${JSON.stringify([...wanted])} → ${ids.length} ids → ${hits.length} notes`,
  );
  return hits;
}

/**
 * Merge query (vector) hits with tag-leg hits into ONE list, deduped by id.
 * Query hits win on collision (they carry a real score); a tag note already
 * surfaced by the search isn't duplicated. Query hits are listed first
 * (score-sorted), then the remaining tag notes (newest-first as fetched).
 */
function mergeHits(
  queryHits: LocalSearchHit[],
  tagHits: LocalSearchHit[],
): LocalSearchHit[] {
  const seen = new Set(queryHits.map((h) => h.id));
  const merged: LocalSearchHit[] = queryHits.map((h) => ({ ...h, via: 'query' }));
  for (const t of tagHits) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(t);
  }
  return merged;
}

export async function searchLocalNotes(args: {
  queries: string[];
  limit?: number;
  tagNames?: string[];
}): Promise<LocalSearchResult> {
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .map((q) => String(q ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_QUERIES);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));
  const tagNames = (Array.isArray(args.tagNames) ? args.tagNames : [])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean);
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(
    `[local-search] start queries=${JSON.stringify(queries)} limit=${limit} ` +
      `tags=${JSON.stringify(tagNames)}`,
  );

  // Tag leg is pure SQLite — run it regardless of embedder/LanceDB readiness so
  // a tags-only request (or a tags+query request while warming) still returns.
  const tagHits = tagNames.length
    ? await fetchTagNotes(tagNames, Math.min(MAX_TAG_NOTE_LIMIT, DEFAULT_TAG_NOTE_LIMIT))
    : [];

  // No queries → tag-only retrieval (or nothing). Never "warming": no vector leg.
  if (!queries.length) return { status: 'ok', hits: tagHits };

  if (!isLocalSearchReady()) {
    // Vector leg can't run yet. Still hand back any tag notes we found; only
    // report 'warming' (retry later) when we have nothing at all.
    // eslint-disable-next-line no-console
    console.log('[local-search] WARMING (lance/embedder not ready)');
    return { status: tagHits.length ? 'ok' : 'warming', hits: tagHits };
  }

  // Embed sequentially (the embed worker serializes anyway), keeping the best
  // score per LanceDB row across queries. embedQuery returns null when the
  // model dropped out from under us mid-request — treat a fully-empty round
  // as warming so the caller can distinguish it from a real zero-hit search.
  const byRowId = new Map<string, RawHit>();
  let embeddedAny = false;
  for (const q of queries) {
    const tQuery = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const vector = await embedQuery(q);
    if (!vector) {
      // eslint-disable-next-line no-console
      console.log(`[local-search] embed FAILED for query="${q.slice(0, 60)}"`);
      continue;
    }
    embeddedAny = true;
    const tEmbed = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const rows = await searchLanceDB(vector, limit * 2, MAX_DISTANCE_AWAY);
    // eslint-disable-next-line no-console
    console.log(
      `[local-search] query="${q.slice(0, 60)}" embed=${tEmbed - tQuery}ms ` +
        `lance=${Date.now() - tEmbed}ms rows=${rows.length}`,
    );
    for (const row of rows) {
      const prev = byRowId.get(row.uniqueid);
      if (!prev || row.score > prev.score) {
        byRowId.set(row.uniqueid, {
          uniqueid: row.uniqueid,
          nodeType: row.nodeType || 'note',
          score: typeof row.score === 'number' ? row.score : 0,
          relatedIds: Array.isArray(row.relatedIds) ? row.relatedIds : [],
        });
      }
    }
  }
  if (!embeddedAny) {
    return { status: tagHits.length ? 'ok' : 'warming', hits: tagHits };
  }

  // Partition: plain note hits hydrate from `notes`; chunk hits hydrate their
  // NoteBody (relatedIds[1], falling back to the row id) for text + parent;
  // canvas hits (nodeType 'view' — title-only embeddings) hydrate compact
  // rows from the `canvases` repo. Before that repo existed, view ids fell
  // into the notes branch, missed in notesFindByIds, and silently dropped.
  const noteIds: string[] = [];
  const viewIds: string[] = [];
  const bodyIdToHit = new Map<string, RawHit>();
  for (const hit of byRowId.values()) {
    if (hit.nodeType === 'note_body') {
      bodyIdToHit.set(hit.relatedIds[1] || hit.uniqueid, hit);
    } else if (hit.nodeType === 'view') {
      viewIds.push(hit.uniqueid);
    } else {
      noteIds.push(hit.uniqueid);
    }
  }

  const [noteDocsRaw, bodyDocsRaw, viewMetaRows] = await Promise.all([
    noteIds.length ? notesFindByIds(noteIds) : Promise.resolve([]),
    bodyIdToHit.size ? noteBodiesFindByIds(Array.from(bodyIdToHit.keys())) : Promise.resolve([]),
    viewIds.length ? canvasesFindMetaByIds(viewIds) : Promise.resolve([]),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    `[local-search] hydrate: ${noteIds.length} note ids → ${noteDocsRaw.length} docs, ` +
      `${bodyIdToHit.size} chunk ids → ${bodyDocsRaw.length} bodies, ` +
      `${viewIds.length} view ids → ${viewMetaRows.length} canvases`,
  );

  // Best hit per FINAL id (chunks collapse onto their parent note id, so a
  // note hit and its own chunk hit dedupe to one entry, keeping max score).
  const byFinalId = new Map<string, LocalSearchHit>();
  const keep = (candidate: LocalSearchHit) => {
    const prev = byFinalId.get(candidate.id);
    if (!prev || candidate.score > prev.score) byFinalId.set(candidate.id, candidate);
  };

  for (const raw of noteDocsRaw) {
    const doc = parseDoc(raw);
    if (!doc?.uniqueid) continue;
    const hit = byRowId.get(doc.uniqueid);
    if (!hit) continue;
    keep({
      id: doc.uniqueid,
      title: String(doc.title || '').trim() || 'Untitled',
      // PDFs/Office docs keep text in fileText (content empty) — same
      // convention as file-index/records.ts.
      snippet: toSnippet(doc.content || doc.fileText || doc.text),
      type: String(doc.noteType || hit.nodeType || 'note'),
      score: hit.score,
      ...(typeof doc.lastModified === 'number' ? { lastModified: doc.lastModified } : {}),
    });
  }

  // Canvas hits: title is the canvas name, snippet is its description (the
  // note-titles digest) — the same fields the cloud canvas search surfaces.
  for (const row of viewMetaRows) {
    if (!row?.uniqueid) continue;
    const hit = byRowId.get(row.uniqueid);
    if (!hit) continue;
    const lastModified = row.updated_at ? Date.parse(row.updated_at) : NaN;
    keep({
      id: row.uniqueid,
      title: String(row.name || '').trim() || 'Untitled',
      snippet: toSnippet(row.description),
      type: 'view',
      score: hit.score,
      ...(Number.isFinite(lastModified) ? { lastModified } : {}),
    });
  }

  const orphanParentIds = new Set<string>();
  const pendingChunkHits: Array<{ hit: LocalSearchHit; parentId: string }> = [];
  for (const raw of bodyDocsRaw) {
    const doc = parseDoc(raw);
    if (!doc?.uniqueid) continue;
    const hit = bodyIdToHit.get(doc.uniqueid);
    if (!hit) continue;
    const parentId = String(doc.referenceId || hit.relatedIds[0] || '').trim();
    if (!parentId) continue;
    const title = String(doc.referenceTitle || '').trim();
    const candidate: LocalSearchHit = {
      id: parentId,
      title: title || 'Untitled',
      snippet: toSnippet(doc.text),
      type: 'note_body',
      score: hit.score,
      ...(typeof doc.lastModified === 'number' ? { lastModified: doc.lastModified } : {}),
    };
    if (!title) {
      orphanParentIds.add(parentId);
      pendingChunkHits.push({ hit: candidate, parentId });
    } else {
      keep(candidate);
    }
  }

  // Backfill chunk titles whose NoteBody lacked referenceTitle.
  if (orphanParentIds.size) {
    const parentDocs = await notesFindByIds(Array.from(orphanParentIds));
    const titles = new Map<string, string>();
    for (const raw of parentDocs) {
      const doc = parseDoc(raw);
      if (doc?.uniqueid) titles.set(doc.uniqueid, String(doc.title || '').trim());
    }
    for (const { hit, parentId } of pendingChunkHits) {
      keep({ ...hit, title: titles.get(parentId) || 'Untitled' });
    }
  }

  const queryHits = Array.from(byFinalId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  // Fold the tag leg in: query hits first (score-ranked), then any tag notes
  // not already surfaced. One combined list per the tool contract.
  const hits = mergeHits(queryHits, tagHits);
  // eslint-disable-next-line no-console
  console.log(
    `[local-search] done → ${hits.length} hits ` +
      `(${queryHits.length} query, ${hits.length - queryHits.length} tag-only)` +
      `${queryHits.length ? ` top ${queryHits[0].score.toFixed(3)} "${queryHits[0].title.slice(0, 50)}"` : ''} ` +
      `in ${Date.now() - startedAt}ms`,
  );
  return { status: 'ok', hits };
}
