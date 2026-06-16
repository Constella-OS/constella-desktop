/**
 * generateQueries — model-bound step: expand the user's query into specific +
 * broad reformulations + likely category tags, for wider recall. Mirrors the
 * backend's generate_research_queries.
 *
 * Runs on ctx.provider (local / claude-cli / codex). If the model is
 * unavailable or the provider is cloud (one-shot not wired yet — see runModel),
 * it DEGRADES to a passthrough that searches the literal query. `primary` is
 * always the user's exact query so retrieval never loses the original intent.
 */
import { runModelOnce } from '../binding/runModel';
import { parseJsonObject } from '../binding/jsonExtract';
import { performQueryExpand } from '../../retrieval/query-expand';
import { getLocalTagVocabulary } from './localSearch';
import type { QuerySet, Step } from '../types';

interface RawQueries {
  specific?: string[];
  broad?: string[];
  tags?: string[];
}

function passthrough(query: string): QuerySet {
  return { primary: query, specific: [query], broad: [], tags: [] };
}

export const generateQueries: Step<string, QuerySet> = async (query, ctx) => {
  const trimmed = (query || '').trim();
  if (!trimmed) return passthrough('');

  // Non-local providers (claude-cli / codex / cloud) can't cheaply expand
  // locally — a CLI/local spawn per step is too costly. Instead they hit the
  // backend's no-auth query-expansion endpoint (stateless, no user data). On any
  // failure (not deployed / offline / timeout) we degrade to the literal query.
  if (ctx.provider !== 'local') {
    const expanded = await performQueryExpand(trimmed, ctx.signal);
    if (!expanded) return passthrough(trimmed);
    return {
      primary: trimmed,
      specific: expanded.specific.length ? expanded.specific : [trimmed],
      broad: expanded.broad,
      tags: expanded.tags,
    };
  }

  // LOCAL: mirror the backend planner (generate_research_queries) — multiple
  // specific + broad reformulations AND category tags selected from the
  // user's REAL vocabulary. localSearch's tag channel then fetches notes
  // carrying those categories and dedup-merges them with the query results.
  const vocab = await getLocalTagVocabulary();
  const tagsBlock = vocab.length
    ? `\nThe user's existing categories: ${JSON.stringify(vocab)}\nFor "tags": pick 0-4 category names from that list that could contain relevant notes. Use EXACT names from the list only; [] if none fit.`
    : `\nFor "tags": return [] (the user has no categories).`;

  const prompt = `Expand this search query for a personal knowledge base into a few specific reformulations, a few broader angles, and likely category tags.

Query: ${trimmed}
${tagsBlock}

Respond with ONLY a JSON object: {"specific": string[], "broad": string[], "tags": string[]}. Keep each list short (max 4). No prose.`;

  const text = await runModelOnce(ctx, prompt);
  if (!text) return passthrough(trimmed); // unavailable / failed

  const parsed = parseJsonObject<RawQueries>(text);
  if (!parsed) return passthrough(trimmed);

  const clean = (arr?: string[]) =>
    Array.isArray(arr)
      ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4)
      : [];

  // Keep only tags that exist in the vocabulary (case-insensitive), mapped
  // back to their canonical casing — a hallucinated category matches nothing
  // in the tag channel and would just waste the search.
  const canonical = new Map(vocab.map((n) => [n.toLowerCase(), n]));
  const validTags = clean(parsed.tags)
    .map((t) => canonical.get(t.trim().toLowerCase()))
    .filter((t): t is string => Boolean(t));

  return {
    primary: trimmed,
    specific: clean(parsed.specific),
    broad: clean(parsed.broad),
    tags: validTags,
  };
};
