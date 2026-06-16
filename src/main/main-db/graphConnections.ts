/**
 * Main-side application of auto-connection edges onto note records.
 *
 * Replaces the old renderer round-trip (emit 'file-graph:connections' →
 * renderer coordinator read-merge-write into its DB): with the note store in
 * main, the engine writes the forward edge on the source's
 * outgoingConnectionsV2 and the reverse on the target's incomingConnectionsV2
 * directly — same upsertGraphConnection merge util the renderer used, so the
 * canvas renders them via the unchanged getOutgoingEdgesForNote path on the
 * next read. db:changed fires per write batch, letting open windows react.
 */
import {
  parseGraphConnections,
  upsertGraphConnection,
  type GraphConnection,
} from '../../models/GraphConnection';
import { notesBulkUpsert, notesFindByIds } from './api';

export interface ConnectionEnvelope {
  source: string;
  target: string;
  data: {
    connectionId?: string;
    connectionType?: string;
    connectionStrength?: number;
    connectionContext?: string;
    sourceIntegration?: string;
    createdAt?: string;
    isAiSuggestion?: boolean;
  };
}

/**
 * Merge each edge envelope into both endpoint notes (skipping envelopes whose
 * endpoints aren't in the store) and persist. Returns how many envelopes were
 * applied.
 */
export async function applyGraphConnectionEnvelopes(
  envelopes: ConnectionEnvelope[],
): Promise<number> {
  let applied = 0;
  for (const env of envelopes ?? []) {
    const { source, target, data } = env;
    if (!source || !target) continue;
    try {
      const docs = await notesFindByIds([source, target]);
      const byId = new Map(
        docs.map((d) => {
          const parsed = JSON.parse(d);
          return [parsed.uniqueid as string, parsed];
        }),
      );
      const src = byId.get(source);
      const tgt = byId.get(target);
      if (!src || !tgt) continue; // both endpoints must exist locally

      const updates = {
        uniqueid: data.connectionId,
        type: (data.connectionType ?? 'references') as any,
        strength:
          typeof data.connectionStrength === 'number'
            ? data.connectionStrength
            : 1,
        context: data.connectionContext ?? '',
        sourceIntegration: data.sourceIntegration ?? '',
        createdAt: data.createdAt ?? '',
        is_ai_suggestion: data.isAiSuggestion ?? true,
      };
      const nextOutgoing = upsertGraphConnection({
        connections: src.outgoingConnectionsV2,
        currentNoteId: source,
        relatedNoteId: target,
        direction: 'outgoing',
        updates,
      });
      const nextIncoming = upsertGraphConnection({
        connections: tgt.incomingConnectionsV2,
        currentNoteId: target,
        relatedNoteId: source,
        direction: 'incoming',
        updates,
      });
      await notesBulkUpsert([
        JSON.stringify({ ...src, outgoingConnectionsV2: nextOutgoing }),
        JSON.stringify({ ...tgt, incomingConnectionsV2: nextIncoming }),
      ]);
      applied += 1;
    } catch (e) {
      console.error('[main-db] failed to apply connection envelope:', e);
    }
  }
  return applied;
}

// True for an edge the Obsidian wikilink pass wrote (hard `[[ ]]` reference) —
// AI-engine edges carry is_ai_suggestion: true and a different sourceIntegration,
// so the reconcile below can never touch them.
function isWikilinkEdge(c: GraphConnection): boolean {
  return (
    c.sourceIntegration === 'obsidian' &&
    c.type === 'references' &&
    !c.is_ai_suggestion
  );
}

/**
 * Reconcile pass for Obsidian wikilink edges: the resolution pass is
 * append-only, so when a `[[link]]` is deleted from a note (or its target file
 * is removed) the previously-written edge would otherwise live forever. Given
 * every note id in the vault and the CURRENT resolved envelope set, this walks
 * the vault's note records in batches and strips any wikilink-tagged edge —
 * outgoing on the source note, incoming on the target — that's no longer in
 * the keep set. Only notes that actually lost an edge are rewritten. Returns
 * the removed edge uniqueids so the caller can purge the same edges from the
 * file-graph SQLite store.
 */
export async function pruneStaleWikilinkEdges(
  noteIds: string[],
  keep: ConnectionEnvelope[],
): Promise<string[]> {
  // Current truth: source → set of targets (and the reverse for incoming).
  const keepOut = new Map<string, Set<string>>();
  const keepIn = new Map<string, Set<string>>();
  for (const env of keep ?? []) {
    if (!env?.source || !env?.target) continue;
    if (!keepOut.has(env.source)) keepOut.set(env.source, new Set());
    keepOut.get(env.source)!.add(env.target);
    if (!keepIn.has(env.target)) keepIn.set(env.target, new Set());
    keepIn.get(env.target)!.add(env.source);
  }

  const removedIds = new Set<string>();
  for (let i = 0; i < noteIds.length; i += 400) {
    const batch = noteIds.slice(i, i + 400);
    let docs: string[] = [];
    try {
      docs = await notesFindByIds(batch);
    } catch (e) {
      console.error('[main-db] wikilink prune: batch read failed:', e);
      continue;
    }
    const updates: string[] = [];
    for (const raw of docs) {
      let note: any;
      try {
        note = JSON.parse(raw);
      } catch {
        continue;
      }
      const id = note?.uniqueid;
      if (!id) continue;

      // For each direction, keep everything except wikilink edges whose other
      // endpoint is no longer linked. (On incoming edges, target_id holds the
      // OTHER note — the edge's source — per the GraphConnection convention.)
      const splitStale = (
        connections: unknown,
        direction: 'outgoing' | 'incoming',
        allowed: Set<string> | undefined,
      ) => {
        const all = parseGraphConnections(connections, id, direction);
        const kept = all.filter((c) => {
          if (!isWikilinkEdge(c) || allowed?.has(c.target_id)) return true;
          removedIds.add(c.uniqueid);
          return false;
        });
        return { all, kept };
      };
      const out = splitStale(
        note.outgoingConnectionsV2,
        'outgoing',
        keepOut.get(id),
      );
      const inc = splitStale(
        note.incomingConnectionsV2,
        'incoming',
        keepIn.get(id),
      );
      if (
        out.kept.length === out.all.length &&
        inc.kept.length === inc.all.length
      ) {
        continue;
      }
      updates.push(
        JSON.stringify({
          ...note,
          outgoingConnectionsV2: out.kept,
          incomingConnectionsV2: inc.kept,
        }),
      );
    }
    if (updates.length) {
      try {
        await notesBulkUpsert(updates);
      } catch (e) {
        console.error('[main-db] wikilink prune: batch write failed:', e);
      }
    }
  }
  return [...removedIds];
}
