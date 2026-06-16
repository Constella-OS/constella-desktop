/**
 * Provider runner (main process).
 *
 * Owns the two main-side provider backends — local (utilityProcess) and
 * claude-cli (child process) — and fans their NormalizedEvent streams back to
 * the renderer over `provider:event` / `provider:status`, keyed by runId. The
 * renderer's bridgedProvider subscribes to those channels.
 *
 * Cloud is NOT here: it stays in the renderer over the existing Stella V2 WS.
 *
 * Also exposes `runOnceMain` — a one-shot text collector for background callers
 * (the synthesis engine, #5) that don't have a renderer to stream to.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  PROVIDER_IPC,
  type NormalizedEvent,
  type ProviderRequest,
  type ProviderId,
  type RunOnceResult,
} from '../../utils/providers/types';
import {
  runClaudeCli,
  runCodexCli,
  detectClaudeBinary,
  detectCodexBinary,
  type CliRunHandle,
} from './agentRunner';
import {
  runLocal,
  localModelAvailable,
  startLocalLlmWorker,
  stopLocalLlmWorker,
} from './localLlmClient';
import { getUserContextPreamble } from '../userContext';

// runId -> cancel fn for in-flight bridged runs.
const activeRuns = new Map<string, () => void>();

// Single pre-warmed claude-cli child (one recall at a time). Spawned on
// `provider:prewarm` at new-chat so its ~1s spawn/load overlaps retrieval; the
// next matching `provider:run` feeds it the prompt instead of spawning fresh.
// claude --print self-aborts ~3s after spawn if unfed, so reuse is gated on
// alive() + a short TTL; otherwise we discard it and spawn normally.
interface PrewarmEntry {
  model?: string;
  thinkingTokens?: number;
  handle: CliRunHandle;
  spawnedAt: number;
}
let prewarmed: PrewarmEntry | null = null;
const PREWARM_TTL_MS = 2500; // < claude's ~3s stdin timeout

function clearPrewarm(): void {
  if (!prewarmed) return;
  // If never fed, cancel the warm child so it doesn't linger / error noisily.
  try {
    if (prewarmed.handle.alive?.()) prewarmed.handle.cancel();
  } catch {
    /* ignore */
  }
  prewarmed = null;
}

/** Spawn a deferred-stdin claude child for the upcoming turn (claude-cli only). */
function prewarmClaude(req: ProviderRequest): void {
  if (req.providerId !== 'claude-cli' || detectClaudeBinary() == null) return;
  clearPrewarm(); // replace any stale warm child
  const handle = runClaudeCli(
    {
      prompt: '', // fed later via feedPrompt
      model: req.model,
      thinkingTokens: req.thinkingTokens,
      timeoutMs: req.timeoutMs ?? 180_000,
      noMcp: true, // recall pre-feeds context; never wire the search MCP
      deferStdin: true,
    },
    () => undefined, // real event sink attached at feedPrompt
  );
  // The warm child rejects if it self-aborts before being fed — swallow so it's
  // not an unhandled rejection; the actual run re-checks alive() before reuse.
  handle.promise.catch(() => undefined);
  prewarmed = {
    model: req.model,
    thinkingTokens: req.thinkingTokens,
    handle,
    spawnedAt: Date.now(),
  };
}

/** Take a usable pre-warmed handle matching this run, or null. Consumes it. */
function takePrewarmed(req: ProviderRequest): CliRunHandle | null {
  const p = prewarmed;
  if (!p) return null;
  prewarmed = null; // consume regardless
  const fresh = Date.now() - p.spawnedAt < PREWARM_TTL_MS;
  const matches =
    req.providerId === 'claude-cli' &&
    p.model === req.model &&
    (p.thinkingTokens ?? undefined) === (req.thinkingTokens ?? undefined);
  if (fresh && matches && p.handle.alive?.() && p.handle.feedPrompt) {
    return p.handle;
  }
  // Stale / mismatched / dead — discard.
  try {
    if (p.handle.alive?.()) p.handle.cancel();
  } catch {
    /* ignore */
  }
  return null;
}

// Timestamp of the most recent interactive (bridged Recall/chat) activity, used
// by the background knowledge-graph engine to yield the shared local-LLM worker
// to the user. Updated whenever a bridged run starts or finishes.
let lastBridgedActivityAt = 0;

/**
 * True while the user is actively running Recall/chat through the shared local
 * worker, or within `cooldownMs` of the last such run. The file-graph engine
 * checks this before every LLM call and defers so interactive latency wins.
 */
export function isRecallActive(cooldownMs = 4000): boolean {
  if (activeRuns.size > 0) return true;
  return Date.now() - lastBridgedActivityAt < cooldownMs;
}

/**
 * Mark that the USER is actively using the shared local worker (recall chat /
 * generate-queries / mindmap). Local interactive calls go through the IPC
 * handlers below + LLMService — NOT through startBridgedRun — so without this
 * they never registered as "recall active", and the file-graph engine kept
 * running background LLM passes that hog the single-sequence worker and stall
 * the user's request (it sits on "Searching…"). Call this from the interactive
 * IPC entry points (never from the main-side file-graph path, which calls
 * runOnceMain directly and must NOT mark itself active).
 */
export function markInteractiveActivity(): void {
  lastBridgedActivityAt = Date.now();
}

/**
 * Fold the recall graph/nodes context + system prompt into a single prompt for
 * the text-only backends (local/CLI), which can't take a structured graph
 * payload the way the cloud WS can. Keeps the same grounding, just inlined.
 */
function buildEffectivePrompt(req: ProviderRequest): {
  prompt: string;
  systemPrompt?: string;
} {
  const gc = req.context?.graphContext as any;
  let preamble = '';
  if (gc && typeof gc === 'object') {
    if (typeof gc.prompt_prefix === 'string' && gc.prompt_prefix.trim()) {
      preamble = gc.prompt_prefix.trim();
    } else {
      // Best-effort: inline a compact JSON of the context so local/CLI answers
      // are grounded in the same nodes the cloud path sees.
      try {
        const compact = JSON.stringify(gc).slice(0, 8000);
        preamble = `Context:\n${compact}`;
      } catch {
        /* ignore unserializable context */
      }
    }
  }
  const prompt = preamble ? `${preamble}\n\n---\n\n${req.prompt}` : req.prompt;

  // Personalize FOREGROUND chat (local model / claude-cli / codex) with the
  // onboarding "who the user is" preamble. Background callers are skipped: the
  // knowledge-graph engine (the main background caller) injects its own copy in
  // file-graph/llm before calling runOnceMain, so gating here avoids a double.
  let { systemPrompt } = req;
  if (!req.background) {
    const userCtx = getUserContextPreamble();
    if (userCtx) {
      systemPrompt = systemPrompt ? `${userCtx}\n\n${systemPrompt}` : userCtx;
    }
  }
  return { prompt, systemPrompt };
}

/** Start a bridged run; stream events to `sender`. Returns once dispatched. */
function startBridgedRun(req: ProviderRequest, sender: WebContents): void {
  const runId = req.runId;
  if (!runId) {
    sender.send(PROVIDER_IPC.status, {
      runId: 'unknown',
      phase: 'error',
      error: 'missing runId',
    });
    return;
  }

  const emit = (event: NormalizedEvent) => {
    if (!sender.isDestroyed()) sender.send(PROVIDER_IPC.event, { runId, event });
  };
  const finish = (phase: 'done' | 'error' | 'cancelled', extra: { error?: string; finalText?: string } = {}) => {
    activeRuns.delete(runId);
    lastBridgedActivityAt = Date.now();
    if (!sender.isDestroyed()) {
      sender.send(PROVIDER_IPC.status, { runId, phase, ...extra });
    }
  };

  lastBridgedActivityAt = Date.now();
  sender.send(PROVIDER_IPC.status, { runId, phase: 'running' });

  if (req.providerId === 'local') {
    const { prompt, systemPrompt } = buildEffectivePrompt(req);
    const handle = runLocal({ prompt, systemPrompt, modelId: req.model }, (text) =>
      emit({ type: 'text-delta', text }),
    );
    activeRuns.set(runId, handle.cancel);
    handle.promise
      .then((r) => {
        emit({ type: 'done', finalText: r.text });
        finish('done', { finalText: r.text });
      })
      .catch((e) => {
        const msg = e?.message || String(e);
        if (msg === 'cancelled' || /aborted/i.test(msg)) {
          finish('cancelled');
        } else {
          emit({ type: 'error', message: msg });
          finish('error', { error: msg });
        }
      });
    return;
  }

  if (req.providerId === 'claude-cli' || req.providerId === 'codex') {
    const { prompt, systemPrompt } = buildEffectivePrompt(req);
    // Recall PRE-FEEDS its retrieved notes into the prompt (buildEffectivePrompt
    // folds graphContext in), so the search MCP tools are redundant — wiring
    // them just makes claude re-run search_notes (which round-trips to the
    // renderer/backend and TIMES OUT, derailing the answer). Only wire MCP for
    // agentic chats that did NOT pre-feed context (no graphContext) and didn't
    // explicitly opt out via tools:false.
    const hasPrefedContext = !!(req.context as any)?.graphContext;
    const wantsTools = req.tools !== false && !hasPrefedContext;

    // Reuse a pre-warmed claude child when eligible — only the no-MCP path,
    // since the warm child was spawned with noMcp (recall pre-feeds context).
    // feedPrompt swaps in the real event sink + writes the prompt, hiding the
    // ~1s spawn/load. Anything else discards the warm child and spawns fresh.
    let handle: CliRunHandle | null = null;
    if (req.providerId === 'claude-cli' && !wantsTools) {
      const warm = takePrewarmed(req);
      if (warm?.feedPrompt) {
        warm.feedPrompt(prompt, emit);
        handle = warm;
      }
    } else {
      clearPrewarm();
    }

    if (!handle) {
      handle =
        req.providerId === 'codex'
          ? runCodexCli(
              {
                prompt,
                systemPrompt,
                model: req.model,
                timeoutMs: req.timeoutMs,
                cwd: req.cwd,
                bypass: req.bypass,
              },
              emit,
            )
          : runClaudeCli(
              {
                prompt,
                systemPrompt,
                model: req.model,
                timeoutMs: req.timeoutMs,
                thinkingTokens: req.thinkingTokens,
                cwd: req.cwd,
                noMcp: !wantsTools,
              },
              emit,
            );
    }
    activeRuns.set(runId, handle.cancel);
    handle.promise
      .then((r) => {
        emit({ type: 'done', finalText: r.finalText });
        finish('done', { finalText: r.finalText });
      })
      .catch((e) => {
        const msg = e?.message || String(e);
        if (msg === 'cancelled') {
          finish('cancelled');
        } else {
          emit({ type: 'error', message: msg });
          finish('error', { error: msg });
        }
      });
    return;
  }

  finish('error', { error: `runner cannot handle provider "${req.providerId}"` });
}

/**
 * One-shot text collector for main-side callers (synthesis). Cloud is not
 * supported from main (no WS here) — use local or claude-cli.
 */
export async function runOnceMain(req: ProviderRequest): Promise<RunOnceResult> {
  try {
    const { prompt, systemPrompt } = buildEffectivePrompt(req);
    if (req.providerId === 'local') {
      const { promise } = runLocal(
        { prompt, systemPrompt, modelId: req.model },
        () => undefined,
      );
      const r = await promise;
      return { text: r.text, ok: true };
    }
    if (req.providerId === 'claude-cli') {
      // Background (file-graph): default to haiku + skip MCP so the call is fast
      // and cheap and never contends with interactive recall (agents-slack pattern).
      const { promise } = runClaudeCli(
        {
          prompt,
          systemPrompt,
          model: req.model ?? (req.background ? 'haiku' : undefined),
          timeoutMs: req.timeoutMs ?? 180_000,
          thinkingTokens: req.thinkingTokens,
          cwd: req.cwd,
          noMcp: req.background,
        },
        () => undefined,
      );
      const r = await promise;
      return { text: r.finalText, ok: true };
    }
    if (req.providerId === 'codex') {
      // Background (file-graph): lightweight gpt-5-nano + high reasoning, exactly
      // like agents-slack's ingest path (INGEST_CODEX_MODEL='gpt-5-nano',
      // reasoning='high'). nano is cheap/fast; high reasoning keeps the
      // classification sharp despite the small model.
      const { promise } = runCodexCli(
        {
          prompt,
          systemPrompt,
          model: req.model ?? (req.background ? 'gpt-5-nano' : undefined),
          reasoningEffort: req.background ? 'high' : undefined,
          timeoutMs: req.timeoutMs ?? 180_000,
          cwd: req.cwd,
          bypass: req.bypass,
        },
        () => undefined,
      );
      const r = await promise;
      return { text: r.finalText, ok: true };
    }
    return { text: '', ok: false, error: `runOnceMain: unsupported provider "${req.providerId}"` };
  } catch (e: any) {
    return { text: '', ok: false, error: e?.message || String(e) };
  }
}

async function detect(id: ProviderId): Promise<boolean> {
  if (id === 'claude-cli') return detectClaudeBinary() != null;
  if (id === 'codex') return detectCodexBinary() != null;
  if (id === 'local') return localModelAvailable();
  return false; // cloud is decided in the renderer
}

export function registerProviderHandlers(): void {
  ipcMain.handle(PROVIDER_IPC.run, (e: IpcMainInvokeEvent, req: ProviderRequest) => {
    startBridgedRun(req, e.sender);
    return { ok: true, runId: req.runId };
  });

  ipcMain.handle(PROVIDER_IPC.cancel, (_e, runId: string) => {
    const cancel = activeRuns.get(runId);
    if (cancel) cancel();
    return { ok: Boolean(cancel) };
  });

  ipcMain.handle(PROVIDER_IPC.detect, (_e, id: ProviderId) => detect(id));

  ipcMain.handle('provider:interactive-activity', () => {
    markInteractiveActivity();
    return { ok: true };
  });

  // Pre-warm a claude-cli child for the upcoming turn (fire-and-forget). The
  // next matching provider:run feeds it the prompt; spawn cost overlaps retrieval.
  ipcMain.handle(PROVIDER_IPC.prewarm, (_e, req: ProviderRequest) => {
    try {
      prewarmClaude(req);
    } catch {
      /* best-effort — never block the renderer on pre-warm */
    }
    return { ok: true };
  });

  ipcMain.handle(PROVIDER_IPC.runOnce, (_e, req: ProviderRequest) => {
    // Interactive (renderer-driven) one-shot — generateQueries, mindmap, etc.
    // Mark activity so the file-graph engine yields the worker to the user.
    markInteractiveActivity();
    return runOnceMain(req);
  });
}

/** Pre-fork the local worker so first local recall doesn't pay spawn cost. */
export function startProviders(): void {
  startLocalLlmWorker();
}

export function stopProviders(): void {
  for (const cancel of activeRuns.values()) {
    try {
      cancel();
    } catch {
      /* ignore */
    }
  }
  activeRuns.clear();
  stopLocalLlmWorker();
}
