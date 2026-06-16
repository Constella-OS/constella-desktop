/**
 * buildMindmap — the mindmap tail: relevant nodes → SIGNIFICANT new connections
 * → {nodes, edges}. "Significant" = typed, strength ≥ floor, not type:none;
 * "new" = pairs already connected are skipped.
 *
 * Provider dispatch (same pattern as synthesizeThemes):
 *   - cloud → /initial-project-generate (mode:'mindmap'); local-only files are
 *     passed as attached_sources so they can be included. Backend does node-
 *     select + classify-connections (significance + skip-existing) itself.
 *   - local / cli → nodeSelect (pick meaningful records) then classifyConnections
 *     (one structured call listing only significant, non-existing edges).
 *
 * Input: merged evidence from `retrieve`. Output: MindmapResult (nodes are
 * RelevantNote instances ready for the canvas; edges are the classified links).
 */
import { CanvasApi } from '../../canvas/canvas-api';
import {
  mapMindmapRecordToRelevantNote,
  type MindmapSourceMetadata,
} from '../../retrieval/cloud-search';
import { runModelOnce } from '../binding/runModel';
import { buildStructuredPrompt } from '../binding/structuredPrompt';
import { parseJsonObject } from '../binding/jsonExtract';
import { mindmapNodesSchema } from '../schemas/mindmapNodes.schema';
import { connectionsSchema } from '../schemas/connections.schema';
import type {
  AttachedSource,
  EvidenceItem,
  MindmapEdge,
  MindmapResult,
  StepCtx,
  Step,
} from '../types';

const STRENGTH_FLOOR = 0.4;
const MAX_NODES = 24;

const isStr = (x: unknown): x is string => typeof x === 'string' && !!x;
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

export const buildMindmap: Step<EvidenceItem[], MindmapResult> = async (
  evidence,
  ctx,
) => {
  const query = ctx.query || '';
  if (ctx.provider === 'cloud') return cloudMindmap(query, evidence, ctx);

  // local / cli
  const selected = await selectNodes(query, evidence, ctx);
  const edges = await classifyConnections(query, selected, ctx);
  const nodes = selected.map((e) => e.raw).filter(Boolean);
  return { nodes, edges };
};

// ---- cloud --------------------------------------------------------------

async function cloudMindmap(
  query: string,
  evidence: EvidenceItem[],
  ctx: StepCtx,
): Promise<MindmapResult> {
  if (!ctx.accessToken) return { nodes: [], edges: [] };
  // User-attached and local-only files need shipping as attached_sources; the
  // backend can find ordinary cloud notes itself.
  const attachedSources = dedupeAttachedSources([
    ...(ctx.attachedSources ?? []),
    ...evidence
      .filter((e) => e.origin === 'local')
      .slice(0, 40)
      .map((e) => ({
        id: e.uniqueid,
        title: e.title || '',
        summary: e.snippet || '',
        content: e.content ?? e.snippet ?? '',
        source_url: '',
        source_type: 'file' as const,
      })),
  ]);
  const res: any = await CanvasApi.initialProjectGenerate(query, ctx.accessToken, {
    mode: 'mindmap',
    maxNodes: MAX_NODES,
    ...(attachedSources.length ? { attachedSources } : {}),
  }).catch((e: any) => {
    console.warn('[ai-pipeline] cloud mindmap failed:', e?.message || e);
    return null;
  });
  if (!res) return { nodes: [], edges: [] };

  const sourceMetadataById = buildSourceMetadataById([
    ...attachedSources,
    ...(Array.isArray(res.attached_sources) ? res.attached_sources : []),
    ...(Array.isArray(res.attachedSources) ? res.attachedSources : []),
  ]);
  const nodes = (res.nodes ?? [])
    .map((n: any) => {
      try {
        const id = String(n?.id ?? n?.uniqueid ?? '').trim();
        return mapMindmapRecordToRelevantNote(n, sourceMetadataById.get(id));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const edges: MindmapEdge[] = (res.edges ?? [])
    .map((ed: any) => ({
      source_id: ed.source_id ?? ed.sourceId,
      target_id: ed.target_id ?? ed.targetId,
      type: ed.type,
      strength: typeof ed.strength === 'number' ? ed.strength : undefined,
      context: isStr(ed.context) ? ed.context : undefined,
    }))
    .filter((e: MindmapEdge) => isStr(e.source_id) && isStr(e.target_id));
  return {
    nodes,
    edges,
    projectName: res.projectName,
    sourcesSummary: res.sourcesSummary,
  };
}

// Removes duplicate attached-source ids before the cloud mindmap request and metadata join.
function dedupeAttachedSources(sources: AttachedSource[]): AttachedSource[] {
  const seen = new Set<string>();
  const out: AttachedSource[] = [];
  for (const source of sources) {
    const id = String(source?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(source);
  }
  return out;
}

// Builds the id lookup used to hydrate sparse backend mindmap nodes after generation.
function buildSourceMetadataById(
  sources: Array<Partial<AttachedSource> & Record<string, unknown>>,
): Map<string, MindmapSourceMetadata> {
  const map = new Map<string, MindmapSourceMetadata>();
  sources.forEach((source) => {
    const id = String(source?.id ?? '').trim();
    if (!id) return;
    map.set(id, {
      id,
      title: typeof source?.title === 'string' ? source.title : undefined,
      summary: typeof source?.summary === 'string' ? source.summary : undefined,
      content: typeof source?.content === 'string' ? source.content : undefined,
      source_url:
        typeof source?.source_url === 'string' ? source.source_url : undefined,
      integration_name:
        typeof source?.integration_name === 'string'
          ? source.integration_name
          : undefined,
      kind:
        typeof source?.kind === 'string'
          ? source.kind
          : typeof source?.source_type === 'string'
            ? source.source_type
            : undefined,
    });
  });
  return map;
}

// ---- local / cli --------------------------------------------------------

/**
 * Pick the records that meaningfully help answer the query (drop tangents).
 * Exported so the homeDiscoverySplit recipe can run this ONE curation pass and
 * feed the curated set to BOTH tails (chat pills/answer AND the canvas nodes),
 * keeping them identical instead of pills=raw-top-N vs nodes=curated.
 */
export async function selectNodes(
  query: string,
  evidence: EvidenceItem[],
  ctx: StepCtx,
): Promise<EvidenceItem[]> {
  if (evidence.length <= 1) return evidence;
  const base = `Query: ${query}

Records:
${evidence
  .map((e) =>
    `[${e.uniqueid}] ${e.title || '(untitled)'} — ${e.snippet || ''}`.slice(0, 200),
  )
  .join('\n')}

Pick every record that meaningfully helps answer the query. Collapse near-duplicates; drop tangential ones.`;
  const text = await runModelOnce(ctx, buildStructuredPrompt(base, mindmapNodesSchema));
  const ids = parseJsonObject<{ nodes?: { source_id?: string }[] }>(text || '')
    ?.nodes?.map((n) => n.source_id)
    .filter(isStr);
  if (!ids || !ids.length) return evidence.slice(0, MAX_NODES);
  const set = new Set(ids);
  const sel = evidence.filter((e) => set.has(e.uniqueid));
  return (sel.length ? sel : evidence).slice(0, MAX_NODES);
}

/**
 * Classify only the SIGNIFICANT, non-existing connections between the nodes.
 * Exported so homeDiscoverySplit can run it AFTER it has already staged the
 * nodes — the (slower) edge pass then streams its edges in via onMindmapEdges
 * rather than holding the whole map back until edges are ready.
 */
export async function classifyConnections(
  query: string,
  nodes: EvidenceItem[],
  ctx: StepCtx,
): Promise<MindmapEdge[]> {
  if (nodes.length < 2) return [];
  const existing = existingPairs(nodes);
  const ids = new Set(nodes.map((n) => n.uniqueid));

  const base = `Query: ${query}

Nodes:
${nodes
  .map((e) =>
    `[${e.uniqueid}] ${e.title || '(untitled)'} — ${e.snippet || ''}`.slice(0, 200),
  )
  .join('\n')}

List ONLY the significant relationships between these nodes (use the uniqueids in [brackets]). Skip weak/obvious links and any pair already connected. For each: {source_id, target_id, type, strength 0-1, context}.`;
  const text = await runModelOnce(ctx, buildStructuredPrompt(base, connectionsSchema));
  const raw = parseJsonObject<{ connections?: any[] }>(text || '')?.connections ?? [];

  const out: MindmapEdge[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const s = c?.source_id;
    const t = c?.target_id;
    if (!isStr(s) || !isStr(t) || s === t) continue;
    if (!ids.has(s) || !ids.has(t)) continue;
    if (c?.type === 'none') continue;
    const strength = typeof c?.strength === 'number' ? c.strength : 0.5;
    if (strength < STRENGTH_FLOOR) continue;
    const key = pairKey(s, t);
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      source_id: s,
      target_id: t,
      type: String(c.type),
      strength,
      context: isStr(c?.context) ? c.context : undefined,
    });
  }
  return out;
}

/** Build the set of already-connected pairs from the nodes' existing edges, so
 *  classifyConnections never re-creates a link that's already there. */
function existingPairs(nodes: EvidenceItem[]): Set<string> {
  const set = new Set<string>();
  for (const n of nodes) {
    const rd: any = (n.raw as any)?.rxdbData;
    if (!rd) continue;
    const targets = [
      ...collectIds(rd.outgoingConnections),
      ...collectIds(rd.incomingConnections),
    ];
    for (const tid of targets) if (tid) set.add(pairKey(n.uniqueid, tid));
  }
  return set;
}

/** Connection arrays may hold plain ids or {uniqueid}/{target_id} objects. */
function collectIds(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const it of arr) {
    if (typeof it === 'string') out.push(it);
    else if (it && typeof it === 'object') {
      const id = (it as any).uniqueid ?? (it as any).target_id ?? (it as any).id;
      if (isStr(id)) out.push(id);
    }
  }
  return out;
}
