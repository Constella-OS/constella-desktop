/**
 * buildQueryList — flatten a QuerySet into the actual list of search strings.
 *
 * Both localSearch and cloudSearch run over these (primary + the generated
 * specific/broad reformulations), so retrieval covers the expanded queries, not
 * just the literal one. Deduped (case-insensitive) and capped to bound the
 * number of searches per recall. `primary` always leads.
 */
import type { QuerySet } from '../types';

const MAX_QUERIES = 4;

export function buildQueryList(qs: QuerySet): string[] {
  const all = [qs.primary, ...(qs.specific || []), ...(qs.broad || [])]
    .map((s) => (s || '').trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of all) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= MAX_QUERIES) break;
  }
  return out.length ? out : [qs.primary];
}
