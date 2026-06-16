/**
 * Provider abstraction — shared types.
 *
 * One interface above every LLM backend (cloud Stella, local node-llama-cpp,
 * Claude Code CLI) so recall/chat AND the background synthesis engine route
 * through the same code. Ported/widened from agents-slack
 * `src/main/agentRunner.ts` (NormalizedEvent + RunRequest), extended to carry
 * Stella's richer events (sources, personalized_ui, mind_map).
 *
 * This file is intentionally PURE — no DOM, no electron, no React imports — so
 * it can be imported from both the renderer and the main process.
 */

export type ProviderId = 'cloud' | 'local' | 'claude-cli' | 'codex';

/**
 * One cited source ("source pill") shown under an answer. Mirrors the record
 * shape the cloud `retrievals_used` frame already feeds into the chat UI; every
 * provider emits the same thing so the UI renders pills identically regardless
 * of backend. Keep loose/optional — different backends populate different subsets.
 */
export interface Citation {
  uniqueid: string;
  title?: string;
  integration?: string;
  url?: string;
  excerpt?: string;
  /** Original backend record, untouched, for callers that want the full object. */
  raw?: unknown;
}

/**
 * The stable event the renderer/consumer cares about. Anything a backend emits
 * is mapped onto one of these; unknown payloads surface as `raw` (never dropped,
 * never rendered) so we can debug new frame types without losing data.
 */
export type NormalizedEvent =
  | { type: 'text-delta'; text: string } // streaming token(s)
  | { type: 'text'; text: string } // whole-message form (final, non-streaming)
  | { type: 'tool-call'; tool: string; status?: string; integration?: string }
  | { type: 'tool-result'; tool: string }
  | { type: 'sources'; citations: Citation[] } // Stella retrievals_used
  | { type: 'ui'; kind: 'personalized_ui' | 'mind_map'; data: unknown }
  | { type: 'meta'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; finalText?: string; chatId?: string }
  | { type: 'raw'; raw: unknown };

/**
 * A single LLM turn request. The same shape feeds streaming chat (`run`) and the
 * one-shot collector (`runOnce`) used by background synthesis.
 */
export interface ProviderRequest {
  providerId: ProviderId;
  prompt: string;
  systemPrompt?: string;
  /** Provider-specific model id. Cloud ignores it (backend-fixed). */
  model?: string;
  /** Enable tool / MCP grounding. MCP wiring is follow-up #6; flag is carried now. */
  tools?: boolean;
  /**
   * Recall/chat context. `graphContext` MUST be the FULL serialized nodes/graph
   * payload the existing recall send builds (message-helpers.ts) — not a
   * stripped copy. Cloud forwards it verbatim; local/CLI fold it into the prompt.
   */
  context?: {
    chatId?: string | null;
    graphContext?: unknown;
    sourceFilters?: string[];
  };
  /** Wall-clock budget before the run is aborted (local/CLI). */
  timeoutMs?: number;
  /** claude-cli only: extended-thinking token budget (MAX_THINKING_TOKENS). */
  thinkingTokens?: number;
  /**
   * claude-cli / codex only: the working directory the CLI child spawns in.
   * Agents set this to their own folder so files the CLI writes land where the
   * Memories browser can see them. Ignored by cloud/local (no child process).
   */
  cwd?: string;
  /**
   * codex only: pass --dangerously-bypass-approvals-and-sandbox so the run can
   * touch the filesystem outside the workspace-write sandbox. Off by default.
   */
  bypass?: boolean;
  /**
   * Background/lightweight one-shot (the file-graph connection + synth engine).
   * Mirrors agents-slack's background path: default to a FAST/cheap model
   * (claude→haiku, codex→gpt-5-nano) and SKIP MCP wiring — the classifier gets
   * its candidates inline and never needs KB tools. Keeps background calls cheap
   * and fast so they don't contend with interactive recall on the same CLI/API.
   */
  background?: boolean;
  /** Correlates the IPC stream for bridged (local/CLI) providers. */
  runId?: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** True when this backend can actually run here (binary present, on desktop, etc.). */
  available(): Promise<boolean>;
  /** Stream normalized events for one turn. Resolve/complete on a `done`/`error` event. */
  run(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<NormalizedEvent>;
}

/** Result of the one-shot collector used by background synthesis. */
export interface RunOnceResult {
  text: string;
  ok: boolean;
  error?: string;
}

// ---- IPC payloads (main <-> renderer) for the bridged providers ----------

/** main -> renderer: one normalized event for an in-flight run. */
export interface ProviderEventPayload {
  runId: string;
  event: NormalizedEvent;
}

/** main -> renderer: terminal status for a run. */
export interface ProviderStatusPayload {
  runId: string;
  phase: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  finalText?: string;
}

/** IPC channel names — single source of truth for both sides. */
export const PROVIDER_IPC = {
  run: 'provider:run',
  cancel: 'provider:cancel',
  runOnce: 'provider:run-once',
  detect: 'provider:detect',
  event: 'provider:event',
  status: 'provider:status',
  // Pre-warm a claude-cli child on new-chat so its ~1s spawn/load overlaps
  // retrieval; the next provider:run reuses it (feeds the prompt) if still alive.
  prewarm: 'provider:prewarm',
} as const;
