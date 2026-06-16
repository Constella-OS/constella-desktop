/**
 * dedupByUniqueId — PURE merge step.
 *
 * Input: the array-of-arrays fanOut([localSearch, cloudSearch]) produces (also
 * tolerates a flat array). Output: one merged EvidenceItem list.
 *
 * Merge contract: dedup by `uniqueid`, keeping the **most recently modified**
 * copy (`modifiedAt`) — so a note edited locally but stale in the cloud (or
 * vice-versa) surfaces its newest version. Ties / missing dates fall back to the
 * cloud record (richer: Postgres body + graph edges). We do NOT sort by score —
 * local 512-dim and cloud 768-dim scores aren't comparable; ranking the merged
 * pile is filterRank's job.
 */
import type { EvidenceItem, Step } from '../types';

function flatten(input: EvidenceItem[] | EvidenceItem[][]): EvidenceItem[] {
  if (input.length === 0) return [];
  return Array.isArray(input[0])
    ? (input as EvidenceItem[][]).flat()
    : (input as EvidenceItem[]);
}

/** Pick the copy to keep: newer modifiedAt wins; tie → cloud; else incumbent. */
function pickLatest(a: EvidenceItem, b: EvidenceItem): EvidenceItem {
  const am = a.modifiedAt ?? -Infinity;
  const bm = b.modifiedAt ?? -Infinity;
  if (bm > am) return b;
  if (am > bm) return a;
  if (b.origin === 'cloud' && a.origin !== 'cloud') return b;
  return a;
}

export const dedupByUniqueId: Step<
  EvidenceItem[] | EvidenceItem[][],
  EvidenceItem[]
> = async (input) => {
  const items = flatten(input);
  const byId = new Map<string, EvidenceItem>();
  for (const it of items) {
    if (!it.uniqueid) continue;
    const existing = byId.get(it.uniqueid);
    byId.set(it.uniqueid, existing ? pickLatest(existing, it) : it);
  }
  return Array.from(byId.values());
};
