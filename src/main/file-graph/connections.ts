/**
 * Per-record auto-connection (Phase: connection-first) — faithful port of the
 * backend `ai/knowledge_graph/connections.py form_connections_for_record`.
 *
 *   item text → generate diverse semantic queries (LLM)
 *             → embed each query → LanceDB vector search → candidate notes
 *             → LLM classifies which to connect to + type/strength/context
 *             → typed GraphConnection edges, persisted in the main-side edge
 *               store AND streamed to the renderer to land on the note records'
 *               incoming/outgoingConnectionsV2 (same shape as backend sync).
 *
 * Connects parent NOTES (nodeType 'note'), scoped to indexed docs via the text
 * store. Prompts are ported verbatim — they are the load-bearing part.
 */
import { searchLanceDB } from '../utils/vector-db/vector-db';
import {
  createGraphConnection,
  VALID_GRAPH_CONNECTION_TYPES,
  type GraphConnection,
  type GraphConnectionType,
} from '../../models/GraphConnection';
import { getGraphDoc, listParentIds, hasGraphDocSync } from './textStore';
import { embedText } from './embed';
import { recordCloudGraphConnectionsUsage, runGraphLLM } from './llm';
import {
  alreadyConnected,
  addOutgoingEdges,
  markProcessed,
  isProcessed,
} from './edgeStore';
import { applyGraphConnectionEnvelopes } from '../main-db/graphConnections';
import {
  MIN_CONTENT_LENGTH,
  MAX_QUERIES_GENERATED,
  VECTOR_RECALL_TOP_K,
  VECTOR_RECALL_MAX_DISTANCE,
  MAX_CANDIDATES_FOR_LLM,
  CONNECTION_STRENGTH_FLOOR,
  CANDIDATE_CONTENT_CHARS,
  SOURCE_CONTENT_CHARS,
  MAX_CONNECT_PER_TICK,
} from './constants';

// Auto-suggested connection types (exclude 'none' + structural 'contains').
const CONNECTABLE_TYPES = new Set<GraphConnectionType>([
  'similar',
  'contradicts',
  'supports',
  'extends',
  'insight',
  'references',
]);

const QUERY_SYSTEM = `Generate diverse retrieval queries for semantic search.
Include rephrasings, adjacent-topic queries, and at least one counter or negation query.
Keep each query short and information-dense.
Output STRICT JSON only: {"queries": ["query one", "query two", ...]}`;

// Ported verbatim from backend connections.py _CLASSIFICATION_PROMPT.
const CLASSIFY_SYSTEM = `Classify how the source and target records relate.
Valid types are: similar, contradicts, supports, extends, insight, references, none.
Use none when there is not enough evidence for a durable graph edge.
Prefer contradiction/support/extends only when the relationship is specific.
Use references when the source mainly cites, quotes, or points back to the target.
For the 'strength' property, determine how confident it seems or how relevant the connection seems to be as a float between 0.0 and 1.0. 0.1 means very very low connection, loosely related. 0.3 means somewhat could be useful. 0.5 means decently related and makes sense. 0.7 is strongly connected and relevant together. 0.9 and up means extremely relevant and user should immediately see this.
CONTEXT TEXT RULES (critical, read twice):
- The context is rendered on a graph edge between two nodes. It must describe the substantive *subject matter* of the connection, never the mechanics of the graph.
- NEVER use meta/self-referential phrases like 'this node', 'this canvas', 'the source', 'the target', 'source note', 'target note', 'both notes', 'this record', 'cites the target', 'candidate for', 'marked as', or 'lists as'. Do not describe what one node does to the other.
- Write the context as a short standalone noun phrase or claim that a human reading it cold would understand without seeing either node. Think of it as a caption for what the connection is ABOUT.
- Good style: concrete subject matter + specific angle. Bad style: narrating the graph relationship.
Example 1 (contradicts): one node claims GraphRAG has great performance, another shows TextRAG outperformed it -> context: 'GraphRAG proven worse than TextRAG on retrieval benchmarks' (NOT 'source contradicts target about RAG performance')
Example 2 (insight): one node says 'always provide free coffee to employees', another is a study that free coffee drives 10%+ consumption but only 5% output -> context: 'keep coffee free; productivity gain doesn't justify cutting it' (NOT 'source insight about target study')
Example 3 (references): a thinking-out-loud note 'how i deal with meaning of life' next to a long email 'Re: Following Up' -> context: 'specific email thread on managing chronic illness meaning' (NOT 'this canvas references managing pain')
Example 4 (supports): short life-philosophy note and a longer essay on meaning-making -> context: 'making sense of life as an ongoing daily practice' (NOT 'both frame making sense of it all as a process')
If you cannot write a non-meta context for a pair, set type to 'none' instead of emitting a meta description.
ECHO RULE (critical): if the best caption you can write is just a restatement of one or both titles, the pair does not carry enough meaning for a durable edge. Set type to 'none'. The caption must add a specific claim, angle, or subject matter not already visible by reading either title alone.
OBVIOUSNESS RULE (critical): only emit edges the user would NOT see at a glance. The graph's value is surfacing non-obvious relationships. If the connection is OBVIOUS from skimming both records (e.g. 'both are about productivity', 'both reference the same author', 'both share a tag'), set type to 'none' — that's noise, not signal. Only emit an edge if you can articulate WHY this pair is interesting beyond their shared topic.
DISPARITY RULE (critical): do NOT force edges between topically disparate items. If two records share no substantive overlap, set type to 'none' even if one tangentially mentions a word in the other. A graph with edges between unrelated material is worse than a sparse graph. When in doubt, return 'none'. Err on the side of fewer, stronger edges.
CRITICAL THINKING RULE: do not agree with a note just because it exists. Treat personal notes skeptically; give authoritative sources more weight. If you notice a gap, flaw, or unsupported leap in either node, prefer 'contradicts' or 'insight' and make the doubt itself the substance of the context (e.g. 'claim assumes X without evidence; cited study only measured Y').
Output STRICT JSON only: {"connections":[{"target_id":"<id>","type":"similar|contradicts|supports|extends|insight|references|none","strength":0.0,"context":"<subject-matter caption>"}]}`;

interface Candidate {
  target_id: string;
  score: number;
  title: string;
  content: string;
}

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Build the diverse query set: base query first, then LLM-generated, deduped. */
async function buildQueries(title: string, content: string): Promise<string[]> {
  const base = `${title}\n${content.slice(0, 300)}`.trim();
  const queries = [base];
  const qres = await runGraphLLM(
    QUERY_SYSTEM,
    `Title: ${title}\nContent: ${content.slice(0, 1200)}`,
    60_000,
    'connection_query',
  );
  if (qres.ok && Array.isArray(qres.json?.queries)) {
    for (const q of qres.json.queries) {
      if (typeof q === 'string' && q.trim()) queries.push(q.trim());
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const n = normalize(q);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(q);
    if (out.length >= MAX_QUERIES_GENERATED) break;
  }
  return out;
}

function buildClassifyPrompt(
  title: string,
  content: string,
  candidates: Candidate[],
): string {
  const cand = candidates
    .map(
      (c) =>
        `- target_id=${c.target_id} | title="${c.title}" | content="${c.content}"`,
    )
    .join('\n');
  return `Source title: ${title}\nSource content: ${content.slice(
    0,
    SOURCE_CONTENT_CHARS,
  )}\n\nCandidates:\n${cand}`;
}

/**
 * Run the full connection pipeline for one indexed note. Returns the number of
 * edges written. Marks the record processed so it isn't re-queried (unless a
 * transient LLM failure, where we leave it for retry).
 */
export async function connectRecord(parentId: string): Promise<number> {
  const tag = `[file-graph:connect ${parentId.slice(0, 8)}]`;
  const doc = await getGraphDoc(parentId);
  if (!doc) {
    console.log(`${tag} drop — no doc text in store`);
    markProcessed(parentId);
    return 0;
  }
  const title = doc.title || '';
  const content = doc.text || '';
  if (`${title} ${content}`.trim().length < MIN_CONTENT_LENGTH) {
    console.log(
      `${tag} drop — content too short (<${MIN_CONTENT_LENGTH} chars): "${title.slice(0, 40)}"`,
    );
    markProcessed(parentId);
    return 0;
  }

  // 1) diverse queries
  const queries = await buildQueries(title, content);

  // 2) candidate finding — vector search each query, dedupe, rank, cap.
  //
  // IMPORTANT: we search with the DEFAULT (recall-style) filter — NOT
  // nodeTypes:['note']. The strict 'note' filter matched ~0 rows in practice
  // because a large share of the stored vectors carry a null/empty nodeType
  // (legacy rows from before the column existed), which the 'note' IN-filter
  // excludes. The default filter (exclude only concept/theme) is the same path
  // recall uses and reliably returns hits. Each hit is then resolved to its
  // PARENT note via the docs text store: parent rows are in `docs` directly;
  // chunk rows (note_body) carry their parent in relatedIds. Anything we can't
  // map to a known parent doc is skipped.
  const candMap = new Map<string, { uniqueid: string; score: number }>();
  let totalHits = 0;
  let embeddedOk = 0;
  let embedFailures = 0;
  for (const q of queries) {
    const vec = await embedText(q);
    if (!vec) {
      embedFailures += 1;
      console.log(`${tag} embed returned null for a query (embedder issue?)`);
      continue;
    }
    embeddedOk += 1;
    const hits = await searchLanceDB(vec, VECTOR_RECALL_TOP_K, VECTOR_RECALL_MAX_DISTANCE);
    totalHits += hits.length;
    for (const h of hits) {
      if (!h?.uniqueid) continue;
      // Resolve the hit to a parent note id: itself if it's a parent doc, else
      // its parent via relatedIds (chunk → parent). Skip rows we can't map.
      let pid = h.uniqueid;
      if (!hasGraphDocSync(pid)) {
        const rel = Array.isArray(h.relatedIds)
          ? h.relatedIds.find((r: string) => r && hasGraphDocSync(r))
          : undefined;
        if (!rel) continue;
        pid = rel;
      }
      if (pid === parentId) continue;
      if (alreadyConnected(parentId, pid)) continue;
      const prev = candMap.get(pid);
      if (!prev || h.score > prev.score) {
        candMap.set(pid, { uniqueid: pid, score: h.score });
      }
    }
  }
  if (candMap.size === 0) {
    // Distinguish transient (embedder down → nothing embedded) from a genuine
    // empty neighborhood. Transient: leave UNPROCESSED so it retries once the
    // embedder is back, instead of silently burning the record.
    if (embeddedOk === 0) {
      console.log(
        `${tag} transient — every query failed to embed (${embedFailures} failure(s)); left unprocessed for retry`,
      );
      return 0;
    }
    console.log(
      `${tag} drop — 0 candidates after ${queries.length} quer${
        queries.length === 1 ? 'y' : 'ies'
      } (${totalHits} raw vector hit(s) mapped to 0 parent notes, maxDist ${VECTOR_RECALL_MAX_DISTANCE.toFixed(
        2,
      )}). Genuinely no related notes in the corpus.`,
    );
    markProcessed(parentId);
    return 0;
  }

  const ranked = Array.from(candMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_FOR_LLM);

  const candidates: Candidate[] = [];
  for (const c of ranked) {
    const cd = await getGraphDoc(c.uniqueid);
    const cTitle = cd?.title || '';
    const cContent = (cd?.text || '').slice(0, CANDIDATE_CONTENT_CHARS);
    if (!cTitle && !cContent) continue; // need something for the LLM to judge
    candidates.push({
      target_id: c.uniqueid,
      score: c.score,
      title: cTitle,
      content: cContent,
    });
  }
  if (!candidates.length) {
    console.log(`${tag} drop — candidates had no title/text to judge`);
    markProcessed(parentId);
    return 0;
  }

  // 3) classify
  const cres = await runGraphLLM(
    CLASSIFY_SYSTEM,
    buildClassifyPrompt(title, content, candidates),
    120_000,
    'connection_classify',
  );
  if (!cres.ok) {
    // transient (LLM failed/recall-deferred) — leave unprocessed for retry
    console.log(
      `${tag} classify failed (${cres.error ?? 'unknown'}) — left unprocessed for retry`,
    );
    return 0;
  }
  const classified = Array.isArray(cres.json?.connections)
    ? cres.json.connections
    : [];
  if (!classified.length) {
    console.log(
      `${tag} classifier returned no connections from ${candidates.length} candidate(s)${
        cres.json == null ? ' (response was not valid JSON)' : ''
      }`,
    );
  }

  // 4) persist — drop none / below-floor / already-connected
  const validTargets = new Set(candidates.map((c) => c.target_id));
  const createdAt = new Date().toISOString();
  const edges: GraphConnection[] = [];
  const envelopes: Array<{ source: string; target: string; data: any }> = [];
  // Tally drop reasons so a record that classifies but persists nothing is legible.
  const drops = { badTarget: 0, noneOrBadType: 0, belowFloor: 0, dup: 0 };

  for (const c of classified) {
    const target = c?.target_id;
    const type = c?.type as GraphConnectionType;
    const strength = Number(c?.strength);
    if (!target || !validTargets.has(target)) {
      drops.badTarget += 1;
      continue;
    }
    if (!CONNECTABLE_TYPES.has(type) || !VALID_GRAPH_CONNECTION_TYPES.includes(type)) {
      drops.noneOrBadType += 1;
      continue;
    }
    if (!(strength >= CONNECTION_STRENGTH_FLOOR)) {
      drops.belowFloor += 1;
      continue;
    }
    if (alreadyConnected(parentId, target)) {
      drops.dup += 1;
      continue;
    }

    const edge = createGraphConnection({
      currentNoteId: parentId,
      relatedNoteId: target,
      direction: 'outgoing',
      type,
      strength: Math.max(0, Math.min(1, strength)),
      context: String(c?.context ?? ''),
      is_ai_suggestion: true,
      createdAt,
    });
    edges.push(edge);
    envelopes.push({
      source: parentId,
      target,
      data: {
        connectionId: edge.uniqueid,
        connectionType: edge.type,
        connectionStrength: edge.strength,
        connectionContext: edge.context,
        sourceIntegration: edge.sourceIntegration,
        createdAt: edge.createdAt,
        isAiSuggestion: true,
      },
    });
  }

  if (edges.length) {
    addOutgoingEdges(parentId, edges);
    // Apply straight onto the note records in the main DB — the renderer
    // round-trip is gone now that main owns note storage.
    await applyGraphConnectionEnvelopes(envelopes);
    if (cres.providerId === 'cloud') {
      await recordCloudGraphConnectionsUsage(edges.length);
    }
    console.log(
      `${tag} wrote ${edges.length} edge(s) from ${candidates.length} candidate(s) [${classified.length} classified]`,
    );
  } else if (classified.length) {
    // Classifier ran but everything was filtered — surface the breakdown so a
    // persistently-empty graph (e.g. floor too high, all 'none') is diagnosable.
    console.log(
      `${tag} 0 edges kept from ${classified.length} classified — drops: none/bad-type ${drops.noneOrBadType}, below-floor(<${CONNECTION_STRENGTH_FLOOR}) ${drops.belowFloor}, bad-target ${drops.badTarget}, already-connected ${drops.dup}`,
    );
  }
  markProcessed(parentId);
  return edges.length;
}

/**
 * Connect a budgeted batch of not-yet-processed indexed notes. Returns the
 * number of records processed this pass (each is ~2 LLM calls, so the budget is
 * small + recall-gated by the scheduler).
 */
export async function runConnectionPass(
  yieldFn: () => Promise<void>,
  budget = MAX_CONNECT_PER_TICK,
): Promise<number> {
  const parents = await listParentIds();
  const remaining = parents.filter((pid) => !isProcessed(pid)).length;
  let processedThisPass = 0;
  let edgesThisPass = 0;
  for (const pid of parents) {
    if (processedThisPass >= budget) break;
    if (isProcessed(pid)) continue;
    edgesThisPass += await connectRecord(pid);
    processedThisPass += 1;
    await yieldFn();
  }
  console.log(
    `[file-graph:connect-pass] ${parents.length} doc(s) total, ${remaining} unprocessed; processed ${processedThisPass} this tick (budget ${budget}), wrote ${edgesThisPass} edge(s)`,
  );
  return processedThisPass;
}
