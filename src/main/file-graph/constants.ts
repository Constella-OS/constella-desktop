/**
 * Tunables for the local knowledge-graph engine (concept pages + themes).
 * Mirrors the agents-slack wiki thresholds, retargeted onto LanceDB cosine
 * distance (distance = 1 - cosineSimilarity).
 */

// Deterministic id namespace (distinct from file-index's namespace).
export const FILE_GRAPH_NAMESPACE = 'b2c7e3a1-9d4f-4e6a-8c0b-2f1a3d5e7c9b';

// LanceDB node types produced by this engine.
export const NODE_TYPE_CONCEPT = 'concept';
export const NODE_TYPE_THEME = 'theme';

// --- clustering -----------------------------------------------------------
export const JOIN_COSINE = 0.78; // cosine similarity to join/seed a cluster
export const JOIN_MAX_DISTANCE = 1 - JOIN_COSINE; // 0.22 cosine distance
export const MIN_CLUSTER = 2;
export const CLUSTER_NEIGHBORS = 8;

// --- linking --------------------------------------------------------------
export const SEMANTIC_THRESHOLD = 0.6; // cosine similarity for a semantic edge
export const SEMANTIC_MAX_DISTANCE = 1 - SEMANTIC_THRESHOLD; // 0.4
export const SEMANTIC_TOP_K = 6;

// --- synthesis (themes) ---------------------------------------------------
export const MIN_GROUP = 3;
export const MAX_GROUP = 15;
export const SYNTH_STRENGTH_FLOOR = 0.55;
export const OVERLAP_SUPERSEDE = 0.4; // Jaccard overlap → update/supersede

// --- scheduling + throttle ------------------------------------------------
export const IDLE_TICK_MS = 60_000;
export const FORCE_INTERVAL_MS = 5 * 60 * 1000;
// Concept-page synthesis cadence — DECOUPLED from themes (mirrors agents-slack,
// where the clustering/concept pass runs every ~5 min while theme synthesis is
// hourly). Kept fast so Discoveries keeps generating concepts as the note graph
// grows; MAX_PAGES_PER_HOUR still bounds cost.
export const CONCEPT_INTERVAL_MS = 2 * 60 * 1000;
// Theme synthesis cadence — hourly, like agents-slack. Themes cluster *concepts*
// into higher-level groups, so they only need to run occasionally once enough
// concepts + concept↔concept edges exist to form communities.
export const SYNTH_INTERVAL_MS = 60 * 60 * 1000;
export const BOOT_DELAY_MS = 12_000; // defer first tick past app boot + file-index
export const MAX_PAGES_PER_TICK = 2; // concept pages extracted per tick (throttle)
export const MAX_PAGES_PER_HOUR = 30; // hard cap, logged when hit
export const MAX_BACKFILL_DOCS = 5000; // first-run text backfill cap, logged
// Yield window after the last interactive LLM call. A recall spans ~30-60s with
// gaps (its embedding/search phases make no LLM call), and the file-graph ticks
// every 60s — so a short 4s window let a connection pass slip into those gaps
// and steal compute mid-recall (slow answers). 25s keeps the whole background
// engine (vector work + LLM) paused across a recall so it gets the machine.
export const RECALL_COOLDOWN_MS = 25000;
export const MAX_CONSECUTIVE_FAILURES = 3; // abort a tick after N LLM failures

// Per-member text fed to the extraction LLM (truncated like agents-slack chunks).
export const PARENT_BODY_CHARS = 1800;
// Max characters of a file persisted in the main-side text store.
export const MAX_STORED_TEXT = 20_000;

// --- auto-connection (ported from backend connection_config.py) -----------
export const MIN_CONTENT_LENGTH = 20; // skip records shorter than this
export const MAX_QUERIES_GENERATED = 5; // base query + LLM queries
export const VECTOR_RECALL_TOP_K = 15; // candidates per query
export const VECTOR_RECALL_THRESHOLD = 0.45; // min cosine similarity
export const VECTOR_RECALL_MAX_DISTANCE = 1 - VECTOR_RECALL_THRESHOLD; // 0.55
export const MAX_CANDIDATES_FOR_LLM = 10; // candidates sent to the classifier
export const CONNECTION_STRENGTH_FLOOR = 0.1; // min strength to persist an edge
export const MAX_CONNECTIONS_PER_RECORD = 20; // cap outgoing edges per node
export const MAX_CONNECT_PER_TICK = 3; // records connected per scheduler tick (throttle)
export const CANDIDATE_CONTENT_CHARS = 800; // candidate text fed to classifier
export const SOURCE_CONTENT_CHARS = 1400; // source text fed to classifier
