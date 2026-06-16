/**
 * Edge accessors — thin shim over the SQLite graph store (graphDb `edges` +
 * `processed` tables). SQLite is now the authoritative main-side edge graph
 * (indexed both directions for O(1) dedup + traversal); edges are mirrored to
 * RxDB note arrays only so the canvas renders them. No RxDB seed needed.
 */
import {
  getGraphDb,
  upsertEdge,
  outgoingEdges,
  connectedPair,
  edgesAboveStrength,
  deleteEdgesByIds,
  isProcessed as dbIsProcessed,
  markProcessed as dbMarkProcessed,
  clearProcessed as dbClearProcessed,
  type EdgeRow,
} from './graphDb';
import type { GraphConnection } from '../../models/GraphConnection';

interface LiteEdge {
  target_id: string;
  strength: number;
  type: string;
}

/** Ensure the DB is open (SQLite migrates lazily on first access). */
export function loadEdgeStore(): void {
  getGraphDb();
}

/** Always true — SQLite is authoritative, there's nothing to seed. */
export function isSeeded(): boolean {
  return true;
}

export function outgoingOf(id: string): LiteEdge[] {
  return outgoingEdges(id).map((e) => ({
    target_id: e.target_id,
    strength: e.strength,
    type: e.type,
  }));
}

export function alreadyConnected(a: string, b: string): boolean {
  return connectedPair(a, b);
}

/** Persist freshly-classified edges (forward edges from the source). */
export function addOutgoingEdges(
  sourceId: string,
  edges: GraphConnection[],
): void {
  for (const e of edges) {
    const row: EdgeRow = {
      uniqueid: e.uniqueid,
      source_id: sourceId,
      target_id: e.target_id,
      type: e.type,
      strength: e.strength,
      context: e.context ?? '',
      is_ai: e.is_ai_suggestion ? 1 : 0,
      created_at: e.createdAt ?? '',
    };
    upsertEdge(row);
  }
}

/** Delete specific edges by uniqueid (e.g. wikilink edges whose `[[link]]`
 *  text was removed from the note). */
export function removeEdgesByIds(ids: string[]): void {
  deleteEdgesByIds(ids);
}

export function isProcessed(id: string): boolean {
  return dbIsProcessed(id);
}
export function markProcessed(id: string): void {
  dbMarkProcessed(id);
}
/** Re-arm a record for the connection pass after its body changed. */
export function clearProcessed(id: string): void {
  dbClearProcessed(id);
}

/** No-op — SQLite writes synchronously (nothing buffered to flush). */
export async function flushEdgeStore(): Promise<void> {
  /* writes are synchronous */
}

/** Undirected adjacency above a strength floor, for community detection.
 *  kind 'note' → note↔note graph (→ concepts); 'concept' → concept↔concept
 *  graph (→ themes). */
export function adjacencyAboveStrength(
  floor: number,
  kind = 'note',
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edgesAboveStrength(floor, kind)) {
    if (!e.source_id || !e.target_id || e.source_id === e.target_id) continue;
    link(e.source_id, e.target_id);
    link(e.target_id, e.source_id);
  }
  return adj;
}
