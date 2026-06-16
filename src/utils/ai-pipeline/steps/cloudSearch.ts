/**
 * cloudSearch — the cloud half of `retrieve` (always runs; not mode-gated).
 *
 * Primary path: ONE POST /search/multi-search carrying the whole generated
 * QuerySet (primary + specific + broad) AND the category tags. The backend
 * embeds every reformulation in one batch, runs the tag channel (recent
 * records per category), and dedup-merges — the same combined retrieval
 * /search/ai-search uses. Falls back to the legacy per-query /web-search
 * fan-out when multi-search isn't available (older deployment / 5xx).
 * NOTE: the legacy fallback deliberately does NOT pass qs.tags — /web-search
 * treats tag_names as a must-include-ALL FILTER, which zeroed out results.
 *
 * Maps the returned `Record<uniqueid, RelevantNote>` into EvidenceItem
 * (origin:'cloud') with `content` (Postgres body) + `modifiedAt` so dedup can
 * keep the latest copy.
 *
 * No-op when there's no auth (offline / logged-out) — retrieval then degrades to
 * local-only instead of throwing.
 */
import {
  performCloudMultiSearch,
  performCloudWebSearch,
} from '../../retrieval/cloud-search';
import { buildQueryList } from './queryList';
import type { EvidenceItem, QuerySet, Step } from '../types';

const PER_QUERY_TOP_K = 12;
// One batched request can afford a wider net than the per-query fan-out —
// the backend dedups internally and filterRank re-ranks downstream.
const MULTI_SEARCH_TOP_K = 24;

export const cloudSearch: Step<QuerySet, EvidenceItem[]> = async (qs, ctx) => {
  if (!ctx.userId || !ctx.accessToken) return []; // can't reach cloud

  try {
    const queries = buildQueryList(qs);

    // --- Primary: one multi-query + tag-channel request. ---
    const multi = await performCloudMultiSearch({
      query: qs.primary || queries[0] || '',
      queries,
      tags: qs.tags,
      userId: ctx.userId,
      accessToken: ctx.accessToken as string,
      topK: MULTI_SEARCH_TOP_K,
      signal: ctx.signal,
    });

    const best = new Map<string, any>();
    if (multi !== null) {
      for (const rn of Object.values(multi)) {
        const id = (rn as any)?.uniqueid ? String((rn as any).uniqueid) : '';
        if (id) best.set(id, rn);
      }
    } else {
      // --- Fallback: legacy per-query fan-out (no tags — see header). ---
      const maps = await Promise.all(
        queries.map((q) =>
          performCloudWebSearch({
            query: q,
            userId: ctx.userId,
            accessToken: ctx.accessToken as string,
            topK: PER_QUERY_TOP_K,
            signal: ctx.signal,
          }).catch(() => ({}) as Record<string, any>),
        ),
      );
      // Merge across queries, keeping the closest (min _distance) per id.
      for (const map of maps) {
        for (const rn of Object.values(map)) {
          const id = (rn as any)?.uniqueid ? String((rn as any).uniqueid) : '';
          if (!id) continue;
          const prev = best.get(id);
          if (
            !prev ||
            ((rn as any)?._distance ?? Infinity) <
              (prev?._distance ?? Infinity)
          ) {
            best.set(id, rn);
          }
        }
      }
    }

    return Array.from(best.values()).map((rn: any) => {
      const rd = rn?.rxdbData;
      const body = typeof rd?.content === 'string' ? rd.content : '';
      return {
        uniqueid: rn?.uniqueid ?? '',
        title: rd?.title ?? undefined,
        snippet: body ? body.slice(0, 400) : undefined,
        content: body ? body.slice(0, 2000) : undefined,
        origin: 'cloud' as const,
        score: typeof rn?._distance === 'number' ? rn._distance : undefined,
        integration: rn?.integrationName ?? rd?.integrationName,
        modifiedAt:
          typeof rd?.lastModified === 'number' ? rd.lastModified : undefined,
        raw: rn,
      };
    });
  } catch (e: any) {
    console.warn('[ai-pipeline] cloudSearch failed:', e?.message || e);
    return [];
  }
};
