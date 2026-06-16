/**
 * Community detection over the connection graph (the "sub-clusters of mindmap
 * ideas" → concepts; concept communities → themes).
 *
 * Uses deterministic label propagation (LPA): each node starts as its own
 * community and iteratively adopts the most common label among its neighbors;
 * dense clusters converge to a shared label. It's a lighter cousin of the
 * backend's Louvain — finds the same kind of partition (groups linked far more
 * to each other than to the rest), without a native/graph dependency. Swap in
 * graphology-communities-louvain later for modularity-optimal splits.
 */
import { MIN_GROUP, MAX_GROUP } from './constants';

export interface Community {
  members: string[];
}

/** Partition an undirected adjacency into communities (size MIN_GROUP..MAX_GROUP). */
export function detectCommunities(adj: Map<string, Set<string>>): Community[] {
  const nodes = Array.from(adj.keys()).sort();
  if (nodes.length === 0) return [];

  const label = new Map<string, string>();
  for (const n of nodes) label.set(n, n);

  const MAX_ITER = 12;
  for (let iter = 0; iter < MAX_ITER; iter += 1) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map<string, number>();
      for (const nb of adj.get(n) ?? []) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      // Highest neighbor-label count wins; ties broken by smallest label id so
      // the result is deterministic across runs.
      let best = label.get(n)!;
      let bestCount = -1;
      for (const [l, c] of Array.from(counts.entries()).sort((a, b) =>
        a[0] < b[0] ? -1 : 1,
      )) {
        if (c > bestCount) {
          bestCount = c;
          best = l;
        }
      }
      if (best !== label.get(n)) {
        label.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const l = label.get(n)!;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(n);
  }

  const out: Community[] = [];
  for (const members of groups.values()) {
    if (members.length < MIN_GROUP) continue;
    out.push({
      members:
        members.length > MAX_GROUP
          ? members.slice().sort().slice(0, MAX_GROUP)
          : members,
    });
  }
  return out;
}
