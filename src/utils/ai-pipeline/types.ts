/**
 * AI Pipeline — shared types.
 *
 * PURE module: no DOM, no electron, no React imports, so it can be used from the
 * renderer, the main process, and the web build alike. See ./README.md for the
 * full mental model (recipe = ordered steps; a recipe is itself a step; one
 * runner threads each step's output into the next).
 */
import type { NormalizedEvent, ProviderId } from '../providers/types';

export type { NormalizedEvent, ProviderId };

/** WHERE evidence comes from. Isolated to the `retrieve` recipe. */
export type PipelineMode = 'local' | 'cloud' | 'hybrid';

/** Which store an evidence item came from. Cloud vectors (768-dim) and local
 *  vectors (512-dim) live in different spaces — see README "vectors are NOT in
 *  the same space". This tag is how downstream steps reason about origin. */
export type Origin = 'local' | 'cloud';

/**
 * One piece of retrieved evidence, normalized so local + cloud results merge
 * into a single list. `score` is provider-LOCAL and NOT comparable across
 * origins (different embedding spaces); ranking across a merged set is the job
 * of `filterRank` (the LLM equalizer), never a raw score sort. `raw` keeps the
 * original record (RelevantNote / backend payload) for synthesis + citations.
 */
export interface EvidenceItem {
  uniqueid: string;
  title?: string;
  /** Short text for ranking / UI (truncated). */
  snippet?: string;
  /** Fuller body for synthesis (hydrated from RxDB locally / Postgres on cloud). */
  content?: string;
  origin: Origin;
  score?: number;
  integration?: string;
  /** Last-modified epoch ms — dedup keeps the most recently modified copy. */
  modifiedAt?: number;
  raw?: unknown;
}

/** One classified mindmap edge — significant + new (already-connected pairs are
 *  dropped). Mirrors the backend classify_connections shape. */
export interface MindmapEdge {
  source_id: string;
  target_id: string;
  type: string;
  strength?: number;
  context?: string;
}

/** Output of the mindmap recipe: selected node records (RelevantNote instances,
 *  loosely typed here to keep the module pure) + the significant edges. */
export interface MindmapResult {
  nodes: unknown[];
  edges: MindmapEdge[];
  projectName?: string;
  sourcesSummary?: string;
}

/** Output of `generateQueries` — the expanded query bundle fed to the searches. */
export interface QuerySet {
  /** The user's literal query, always present (used even when expansion fails). */
  primary: string;
  specific: string[];
  broad: string[];
  tags: string[];
}

/**
 * A structured-output contract. ONE schema drives all three provider bindings:
 * cloud `response_format`, local GBNF grammar, and CLI strict-prompt + extractor.
 */
export interface PipelineSchema {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * Context threaded unchanged through every step. Steps read `mode` + `provider`
 * to self-configure (they never branch on "which task am I in"); `emit` streams
 * progress + final frames to the UI as NormalizedEvents (same vocabulary the
 * provider layer already uses, so applyNormalizedToChat renders them unchanged).
 */
export interface StepCtx {
  mode: PipelineMode;
  provider: ProviderId;
  userId: string;
  accessToken?: string;
  signal?: AbortSignal;
  /** Sink for streaming events. Defaults to a no-op when not rendering to a UI. */
  emit: (event: NormalizedEvent) => void;
  /** How many results each search returns / how much evidence to keep. */
  topK?: number;
  /**
   * Optional note-type denylist applied in the search steps (currently
   * localSearch). When set, evidence whose underlying record type is in this
   * list is dropped from results — e.g. ['view'] excludes saved-view / canvas
   * records from related-note suggestions. Opt-in per surface; most callers
   * leave it undefined so nothing is filtered.
   */
  excludeTypes?: string[];
  /** Optional local model id (lastLoadedModelId). undefined → recommended model. */
  modelId?: string;
  /** claude-cli extended-thinking budget (MAX_THINKING_TOKENS). Recall sets this
   *  high for Sonnet-4.6 follow-ups; undefined → no extended thinking. */
  thinkingTokens?: number;
  /**
   * The user's original query. Threaded on ctx (not the data flow) because steps
   * after `generateQueries` transform the data into QuerySet → evidence, losing
   * the literal query; filterRank + synthesize still need it to judge relevance
   * and ground the answer.
   */
  query?: string;
  /** Local conversation id — used by the cloud chat (WS) path for correlation. */
  chatId?: string | null;
  /** Recent conversation history, folded into the local/CLI chat context. */
  history?: string;
  /**
   * Cloud chat capability, injected by the entry hook (the Stella V2 WS lives in
   * React, not in a pure step). aiChat's cloud path calls this; the WS hook then
   * streams + renders the answer via its own handler. Local/CLI stream via
   * ctx.emit instead.
   */
  cloudChat?: (args: {
    message: string;
    chatId: string;
    graphContext?: unknown;
  }) => Promise<void>;
  /** User-attached sources for initialProjectGenerate (home ask bar). */
  attachedSources?: AttachedSource[];
  /**
   * On-screen graph context (nodes currently displayed on the canvas, WITH
   * title + content) — the output of buildStructuredGraphContextPayload(). The
   * cloud WS ships this server-side; for local/CLI chat we fold it into the
   * prompt so on-device answers are grounded in the same nodes. Loosely typed to
   * keep this module free of Stella V2 imports.
   */
  graphContext?: unknown;
  /**
   * Mid-flight hand-off for the homeDiscoverySplit recipe: called with the built
   * mindmap as soon as buildMindmap resolves, BEFORE the chat answer streams.
   * The split-view entry uses it to stage the nodes so they can drain onto the
   * canvas the instant the chat's first token arrives (the recipe runs the two
   * model-bound tails SEQUENTIALLY — the local provider shares one worker — so
   * this is how the caller gets the nodes without waiting for the whole run).
   */
  onMindmap?: (mindmap: MindmapResult) => void;
  /**
   * Companion to onMindmap for the homeDiscoverySplit recipe's node-before-edges
   * staging. onMindmap delivers the NODES the moment the curation pass picks them
   * (so they drain onto the canvas right away); onMindmapEdges then delivers the
   * edges once the slower classify-connections pass finishes. The split-view
   * entry appends these edges to the already-staged mindmap so they stream in
   * after the nodes instead of gating the whole map on the edge pass.
   */
  onMindmapEdges?: (edges: MindmapEdge[]) => void;
}

/**
 * A user-attached source (uploaded file / pasted link) the home ask bar collects
 * before generation. Threaded on ctx so synthesizeThemes can forward them to the
 * cloud /initial-project-generate endpoint (merged with retrieved evidence).
 */
export interface AttachedSource {
  id: string;
  title: string;
  summary: string;
  content: string;
  source_url: string;
  source_type: string;
}

/** The atom: one (input, ctx) => output function. A recipe is also a Step. */
export type Step<In, Out> = (input: In, ctx: StepCtx) => Promise<Out>;
