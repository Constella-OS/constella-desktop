/**
 * localSearch — the local half of `retrieve` (always runs; not mode-gated).
 *
 * HYBRID (vector + keyword): for each generated query we run two arms —
 *   1. vector: LanceDB similarity (ids + cosine distance, no content);
 *   2. keyword: MiniSearch over title + body (content/fileText), OR + fuzzy.
 * The arms live in different score spaces (cosine distance vs keyword score), so
 * we NEVER compare their scores — we merge by **Reciprocal Rank Fusion** (k=60),
 * the same "merge result sets, never raw scores" doctrine the local↔cloud hybrid
 * uses. dedupByUniqueId + the LLM filterRank downstream do the real merge/rank.
 *
 * LanceDB stores only vectors + ids, so a raw hit is just {uniqueid, _distance};
 * MiniSearch hits are {uniqueid, ...}. The actual note content lives in RxDB
 * (NoteRxdbData / NoteBodyRxdbData), so we HYDRATE the fused top-N ids through
 * parseVectorDBSearchResults (the same path the overlay + canvas search use) →
 * RelevantNote with rxdbData populated → real title/body → EvidenceItem
 * (origin:'local') with `modifiedAt` so dedup can keep the latest.
 *
 * No-op on web (no local vector store) and when the platform isn't desktop.
 */
import { searchAstroDBUsingString } from '../../../db/astro-wrapper';
import { rxdbFindAllTags } from '../../../db/tags-localrxdb';
import { rxdbFindAllNotes } from '../../../db/notes-localrxdb';
import { mapRecordToRelevantNote } from '../../retrieval/cloud-search';
import { parseVectorDBSearchResults } from '../../note-logic';
import { searchMiniSearch } from '../../minisearch';
import { getPlatform } from '../../../platform/platformInstance';
import { SpecificSearchMode } from '../../types';
import { buildQueryList } from './queryList';
import type { EvidenceItem, QuerySet, Step } from '../types';

// 0–100 similarity knob (see getDistanceAwayForResults); 50 is the neutral
// default the app uses for general recall.
const SIMILARITY_STRENGTH = 50;
const PER_QUERY_LIMIT = 12;
// Standard RRF damping constant: a higher k flattens the rank curve so a strong
// keyword-only hit can still out-rank a mediocre vector hit (and vice-versa).
const RRF_K = 60;
// Bound the fused candidate pool so hydration + the filterRank prompt stay small
// (filterRank re-ranks these anyway, so the tail past this barely matters).
const MAX_LOCAL_CANDIDATES = 30;
// Tag-channel cap — most recent notes carrying any generated category. Mirrors
// the backend's tag channel (ai-search: 100/tag fetched, 30/tag surfaced) at a
// scale that keeps local hydration + the filterRank prompt small.
const MAX_TAG_CANDIDATES = 15;

function localStoreAvailable(): boolean {
  try {
    return getPlatform().name === 'desktop';
  } catch {
    return false; // pre-bootstrap / web
  }
}

/**
 * The user's local category (tag) vocabulary — distinct tag names from RxDB.
 * Fed into generateQueries' prompt so the local model picks EXACT existing
 * names (the backend planner does the same with Qdrant tag records). Returns
 * [] on web / before the platform mounts, so callers can include it blindly.
 */
export async function getLocalTagVocabulary(max = 150): Promise<string[]> {
  if (!localStoreAvailable()) return [];
  try {
    const all = await rxdbFindAllTags();
    const names = Object.values(all || {})
      .map((t: any) => String(t?.name || '').trim())
      .filter(Boolean);
    return Array.from(new Set(names)).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * Tag channel — uniqueids of the most recently modified notes carrying ANY of
 * the generated category names (case-insensitive match against the user's tag
 * records). Mirrors the backend ai-search tag channel; the caller appends
 * these AFTER the query-fused candidates and dedups by uniqueid (tag and
 * vector ranks live in different spaces, so we never interleave by score).
 */
async function searchLocalByTags(tagNames: string[]): Promise<string[]> {
  const wanted = (tagNames || [])
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return [];
  try {
    const all = await rxdbFindAllTags();
    const matched = Object.values(all || {}).filter((t: any) =>
      wanted.includes(String(t?.name || '').trim().toLowerCase()),
    );
    if (!matched.length) return [];
    // OR across the matched tags; sort by recency like the backend's
    // sort_by_recent tag fetch, then cap.
    const notes = await rxdbFindAllNotes(false, 0, [], matched as any[]);
    return [...(notes || [])]
      .sort(
        (a: any, b: any) =>
          (b?.lastModified ?? b?._data?.lastModified ?? 0) -
          (a?.lastModified ?? a?._data?.lastModified ?? 0),
      )
      .slice(0, MAX_TAG_CANDIDATES)
      .map((n: any) => String(n?.uniqueid ?? n?._data?.uniqueid ?? ''))
      .filter(Boolean);
  } catch (e: any) {
    console.warn('[ai-pipeline] localSearch tag channel failed:', e?.message || e);
    return [];
  }
}

export const localSearch: Step<QuerySet, EvidenceItem[]> = async (qs, ctx) => {
  if (!localStoreAvailable()) return []; // platform gate (web)

  try {
    const queries = buildQueryList(qs);

    // --- Tag arm (concurrent with the query arms): notes carrying any of the
    // generated categories. Combined at the end via dedup, never by score. ---
    const tagIdsPromise = searchLocalByTags(qs.tags || []);

    // --- Vector arm: each query's LanceDB search (ids + distances, NO content),
    // run concurrently. ---
    const rawSets = await Promise.all(
      queries.map((q) =>
        searchAstroDBUsingString(
          q,
          PER_QUERY_LIMIT,
          SIMILARITY_STRENGTH,
          true,
          SpecificSearchMode.NONE,
        ).catch(() => [] as any[]),
      ),
    );

    // --- Keyword arm: MiniSearch over title + body. Synchronous + in-memory.
    // We opt into the body fields HERE only — backlink/title pickers elsewhere
    // keep their default title-only behavior. OR + fuzzy favors recall (the
    // candidate pool is re-ranked by filterRank anyway). ---
    const kwSets = queries.map((q) => {
      try {
        return searchMiniSearch(q, true, {
          fields: ['title', 'content', 'fileText'],
          combineWith: 'OR',
          prefix: true,
          fuzzy: 0.2,
        });
      } catch {
        return [] as any[];
      }
    });

    // Best vector raw row per id (min _distance). These rows carry
    // nodeType/relatedIds, so a chunk hit still hydrates to its parent note;
    // keyword-only ids fall back to a minimal {uniqueid} (parseVectorDBSearchResults
    // hydrates that fine — it's how the app's own hybridSearch feeds MiniSearch hits).
    const bestRaw = new Map<string, any>();
    for (const set of rawSets) {
      if (!Array.isArray(set)) continue;
      for (const h of set) {
        const id = h?.uniqueid ? String(h.uniqueid) : '';
        if (!id) continue;
        const prev = bestRaw.get(id);
        if (!prev || (h?._distance ?? Infinity) < (prev?._distance ?? Infinity)) {
          bestRaw.set(id, h);
        }
      }
    }

    // --- Reciprocal Rank Fusion across every list of BOTH arms. We fuse by RANK,
    // never by raw score (cosine distance and keyword score aren't comparable). ---
    const rrf = new Map<string, number>();
    const addRanked = (ids: string[]) => {
      ids.forEach((id, rank) => {
        if (!id) return;
        rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank));
      });
    };
    // Vector lists ranked by ascending distance (closest = best). LanceDB usually
    // returns them sorted, but sort defensively so the rank is correct.
    for (const set of rawSets) {
      if (!Array.isArray(set)) continue;
      const ids = [...set]
        .sort((a, b) => (a?._distance ?? Infinity) - (b?._distance ?? Infinity))
        .map((h) => (h?.uniqueid ? String(h.uniqueid) : ''))
        .filter(Boolean);
      addRanked(ids);
    }
    // Keyword lists already arrive sorted by relevance (best first).
    for (const set of kwSets) {
      if (!Array.isArray(set)) continue;
      addRanked(
        set
          .map((h: any) => (h?.uniqueid ? String(h.uniqueid) : ''))
          .filter(Boolean),
      );
    }
    const tagIds = await tagIdsPromise;
    console.log(
      '[ai-pipeline] localSearch arms: queries=',
      queries.length,
      'fused=',
      rrf.size,
      'tags=',
      (qs.tags || []).length,
      'tagHits=',
      tagIds.length,
    );
    if (rrf.size === 0 && tagIds.length === 0) return [];

    // Top-N fused ids → raw rows for hydration.
    const rawCandidates = Array.from(rrf.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LOCAL_CANDIDATES)
      .map(([id]) => bestRaw.get(id) ?? { uniqueid: id });

    // Fold the tag channel in AFTER the fused query results (the backend's
    // ai-search does the same: vector results first, tag records appended),
    // deduping by uniqueid. filterRank re-ranks the merged pool downstream.
    const present = new Set(
      rawCandidates.map((c: any) => String(c?.uniqueid ?? '')),
    );
    for (const id of tagIds) {
      if (present.has(id)) continue;
      present.add(id);
      rawCandidates.push(bestRaw.get(id) ?? { uniqueid: id });
    }

    // Hydrate ids → RxDB content. connectivitySetting=1 = no graph expansion
    // beyond the matches themselves; we only want the hits hydrated.
    const hydrated = await parseVectorDBSearchResults(
      rawCandidates,
      false,
      1,
      false,
      [],
      {},
      [],
      false,
    );

    const evidence: EvidenceItem[] = Object.values(hydrated).map((rn: any) => {
      const rd = rn?.rxdbData;
      // note → content; chunk (note_body) → text; file-indexed PDF/doc →
      // fileText (content stays EMPTY for those — see file-index/records.ts);
      // parent label → referenceTitle
      const body =
        (typeof rd?.content === 'string' && rd.content) ||
        (typeof rd?.text === 'string' && rd.text) ||
        (typeof rd?.fileText === 'string' && rd.fileText) ||
        '';
      return {
        uniqueid: rn?.uniqueid ?? '',
        title: rd?.title ?? rd?.referenceTitle ?? undefined,
        snippet: body ? body.slice(0, 400) : undefined,
        content: body ? body.slice(0, 2000) : undefined,
        origin: 'local' as const,
        score: typeof rn?._distance === 'number' ? rn._distance : undefined,
        integration: rd?.integrationName,
        modifiedAt:
          typeof rd?.lastModified === 'number' ? rd.lastModified : undefined,
        raw: rn,
      };
    });

    // --- Storage-aware fallback: the candidate ids that hydrated to NOTHING
    // (LanceDB hit but RxDB row gone) or to a TEXT-LESS row (row exists but
    // content/fileText empty — the reconcile only repairs fully-missing rows)
    // are looked up in the main process's graph `docs` SQLite, which stores
    // every indexed file's full text. Without this, locally-indexed documents
    // (Documents/Downloads/Obsidian PDFs etc.) could be found by search yet
    // arrive at the AI with no title/body — or not arrive at all.
    await backfillFromMainTextStore(rawCandidates, evidence);

    // Optional per-surface type denylist (e.g. ['view'] to exclude saved-view /
    // canvas records from related-note suggestions). Off unless ctx asks for it.
    if (ctx.excludeTypes?.length) {
      const excluded = new Set(ctx.excludeTypes);
      const isExcluded = (e: EvidenceItem) => {
        const raw: any = e.raw;
        const t = raw?.type ?? raw?.rxdbData?.type;
        return t != null && excluded.has(String(t));
      };
      return evidence.filter((e) => !isExcluded(e));
    }

    return evidence;
  } catch (e: any) {
    console.warn('[ai-pipeline] localSearch failed:', e?.message || e);
    return [];
  }
};

/** IPC bridge to the main process's graph `docs` SQLite (full doc texts). */
async function fetchMainStoreDocTexts(
  ids: string[],
): Promise<Record<string, { title?: string; path?: string; text?: string }>> {
  try {
    const ipc = (globalThis as any)?.window?.electron?.ipcRenderer;
    if (!ipc?.invoke || ids.length === 0) return {};
    const res = await ipc.invoke('file-index:get-doc-texts', { ids });
    return res?.docs && typeof res.docs === 'object' ? res.docs : {};
  } catch {
    return {};
  }
}

/**
 * Patch text-less evidence (and synthesize items for RxDB-missing hits) from
 * the main-process doc store. Mutates `evidence` in place: existing items get
 * their snippet/content (+ raw rxdbData.fileText, so downstream consumers like
 * the mindmap attach + chat prompt see the body) backfilled; ids with no RxDB
 * row at all become new evidence items shaped like the reconcile's note rows.
 */
async function backfillFromMainTextStore(
  rawCandidates: Array<Record<string, any>>,
  evidence: EvidenceItem[],
): Promise<void> {
  const byId = new Map(evidence.map((e) => [e.uniqueid, e]));
  const needs: string[] = [];
  for (const c of rawCandidates) {
    const id = c?.uniqueid ? String(c.uniqueid) : '';
    if (!id) continue;
    const ev = byId.get(id);
    if (!ev || (!ev.content && !ev.snippet)) needs.push(id);
  }
  if (needs.length === 0) return;

  const docs = await fetchMainStoreDocTexts(needs);
  const foundIds = Object.keys(docs);
  console.log(
    '[ai-pipeline] localSearch main-store backfill:',
    needs.length,
    'text-less hit(s),',
    foundIds.length,
    'recovered from graph docs',
  );

  for (const [id, doc] of Object.entries(docs)) {
    const body = (doc.text || '').trim();
    const fileName = (doc.path || '').split('/').pop() || '';
    const title =
      (doc.title || fileName || '').replace(/\.[^.]+$/, '') || undefined;
    if (!body && !title) continue;

    const existing = byId.get(id);
    if (existing) {
      // RxDB row existed but carried no text — backfill the evidence + the
      // raw note so every downstream consumer reads the real body.
      if (body) {
        existing.snippet = existing.snippet || body.slice(0, 400);
        existing.content = existing.content || body.slice(0, 2000);
        try {
          const rd: any = (existing.raw as any)?.rxdbData;
          if (rd && !rd.content && !rd.fileText) rd.fileText = body;
        } catch {
          /* raw not patchable — evidence fields still carry the text */
        }
      }
      if (!existing.title && title) existing.title = title;
    } else {
      // No RxDB row at all (lost to a wipe/race) — synthesize the evidence
      // item directly from the stored doc, mirroring reconcile's note shape.
      const rn = mapRecordToRelevantNote({
        uniqueid: id,
        title: title || 'Untitled',
        content: '',
        fileText: body,
        fileName,
        filePath: doc.path || '',
        noteType: 'pdf',
        integrationName: 'local',
        subtype: 'local_file',
        tags: [],
        vector: [],
      } as any);
      const item: EvidenceItem = {
        uniqueid: id,
        title,
        snippet: body ? body.slice(0, 400) : undefined,
        content: body ? body.slice(0, 2000) : undefined,
        origin: 'local' as const,
        integration: 'local',
        raw: rn,
      };
      evidence.push(item);
      byId.set(id, item);
    }
  }
}
