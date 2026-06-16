/**
 * Main-process client for the local LLM worker (see ai/workers/local-llm-worker.js).
 *
 * Forks one `utilityProcess`, correlates request/response by id, streams token
 * progress back into the caller's onToken callback, and auto-respawns if the
 * worker dies. Inference runs in the worker so the main thread / renderer never
 * stalls — this is the LocalProvider's backend.
 *
 * Ported in shape from agents-slack `src/main/ragClient.ts`.
 */
import fs from 'fs';
import path from 'path';
import { app, utilityProcess, type UtilityProcess } from 'electron';

import { LLMDownloadService } from '../ai/llm-download';
import { getRecommendedModel, getModelById } from '../ai/llm-config';
import { getAppleMetalWorkaroundEnv } from '../appleMetalGuardrails';

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  onProgress?: (info: any) => void;
};

let child: UtilityProcess | null = null;
let starting: Promise<UtilityProcess> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

const downloadService = new LLMDownloadService();

/**
 * Resolve the worker .js the same way the existing embedding workers are
 * referenced (cwd-relative in dev/prod). Fall back to a path next to the
 * compiled main bundle for packaged builds.
 */
function workerPath(): string {
  const candidates = [
    path.join(process.cwd(), 'src/main/ai/workers/local-llm-worker.js'),
    path.join(__dirname, '../ai/workers/local-llm-worker.js'),
    path.join(__dirname, 'ai/workers/local-llm-worker.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  // Last resort: the cwd-relative string the legacy workers use.
  return './src/main/ai/workers/local-llm-worker.js';
}

function rejectAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function handleMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'progress') {
    pending.get(msg.id)?.onProgress?.(msg.info);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'result') p.resolve(msg.value);
  else if (msg.type === 'error')
    p.reject(new Error(msg.message || 'local llm worker error'));
}

function ensureChild(): Promise<UtilityProcess> {
  if (child) return Promise.resolve(child);
  if (starting) return starting;
  starting = new Promise<UtilityProcess>((resolve, reject) => {
    let proc: UtilityProcess;
    try {
      // The dev main runs under tsx (`NODE_OPTIONS=--import=tsx`). A
      // utilityProcess rejects most NODE_OPTIONS at bootstrap, and the worker
      // is plain JS anyway, so strip the dev loader envs.
      const workerEnv: NodeJS.ProcessEnv = { ...process.env };
      delete workerEnv.NODE_OPTIONS;
      delete workerEnv.ELECTRON_RUN_AS_NODE;
      // Belt-and-suspenders: the worker process loads node-llama-cpp, so make
      // sure the Apple-Silicon Metal guardrails are present in its env even if
      // main somehow hadn't applied them. Computed fresh; no-op off macOS-arm64.
      Object.assign(workerEnv, getAppleMetalWorkaroundEnv(workerEnv));
      proc = utilityProcess.fork(workerPath(), [], {
        serviceName: 'constella-llm-worker',
        stdio: 'pipe',
        env: workerEnv,
        // node-llama-cpp holds the model in native memory, but give the JS heap
        // headroom too. --js-flags is the Electron-correct way to pass V8 flags.
        execArgv: ['--js-flags=--max-old-space-size=4096'],
      });
      proc.stdout?.on('data', (d: Buffer) =>
        process.stdout.write(`[llm-worker] ${d}`),
      );
      proc.stderr?.on('data', (d: Buffer) =>
        process.stderr.write(`[llm-worker:err] ${d}`),
      );
    } catch (e) {
      starting = null;
      reject(e);
      return;
    }
    let ready = false;
    proc.on('message', (msg: any) => {
      if (!ready && msg?.type === 'ready') {
        ready = true;
        child = proc;
        starting = null;
        resolve(proc);
        return;
      }
      handleMessage(msg);
    });
    proc.on('exit', (code) => {
      child = null;
      starting = null;
      const err = new Error(`local llm worker exited (code ${code})`);
      rejectAllPending(err);
      if (!ready) reject(err);
      console.warn('[llm] worker exited', code, '— will respawn on next call');
    });
  });
  return starting;
}

function call(
  method: string,
  args: any[],
  onProgress?: (info: any) => void,
): { id: number; promise: Promise<any> } {
  const id = (seq += 1);
  const promise = (async () => {
    const proc = await ensureChild();
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      try {
        proc.postMessage({ type: 'call', id, method, args });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  })();
  return { id, promise };
}

/** Resolve which model file to load: explicit id, else the recommended one. */
async function resolveModelPath(modelId?: string): Promise<string | null> {
  const cfg = (modelId ? getModelById(modelId) : undefined) ?? getRecommendedModel();
  if (!cfg) return null;
  const downloaded = await downloadService.isModelDownloaded(cfg.filename);
  if (!downloaded) return null;
  return downloadService.getModelPath(cfg.filename);
}

/**
 * The context window to create for a model. Qwen3 supports 32768 natively; the
 * old hard-coded 4096 silently truncated/garbled any prompt with more than a
 * few retrieved notes (the mindmap selects up to 24, and the chat grounds on
 * the retrieved evidence) — which produced EMPTY answers + degenerate structured
 * output. We use the model's configured size (the worker auto-fits to available
 * memory up to this max), defaulting conservatively when unknown.
 */
function resolveContextSize(modelId?: string): number {
  const cfg = (modelId ? getModelById(modelId) : undefined) ?? getRecommendedModel();
  // Cap well below the model's max (Qwen3 = 32768). Our actual prompts are only
  // ~2-3k tokens (and ≤15k even with the large-PDF data cap), so a huge context
  // is pure KV-cache memory overhead — and on the Apple-Metal guardrail path
  // (GGML_METAL_NO_RESIDENCY) a smaller KV cache is noticeably faster.
  const MAX_LOCAL_CONTEXT = 16384;
  return Math.min(cfg?.contextSize ?? 8192, MAX_LOCAL_CONTEXT);
}

/** True when a usable local model file is present on disk. */
export async function localModelAvailable(modelId?: string): Promise<boolean> {
  return (await resolveModelPath(modelId)) != null;
}

export interface LocalRunArgs {
  prompt: string;
  systemPrompt?: string;
  modelId?: string;
}

/**
 * Run one local inference, streaming text chunks to `onToken`. Resolves with the
 * full assembled answer. Returns a `cancel()` that aborts the in-flight stream.
 */
export function runLocal(
  args: LocalRunArgs,
  onToken: (text: string) => void,
): { promise: Promise<{ text: string }>; cancel: () => void } {
  // Worker-side run id, set once the run is dispatched; cancel() targets it.
  let activeRunId: number | null = null;

  const promise = (async () => {
    const modelPath = await resolveModelPath(args.modelId);
    if (!modelPath) {
      throw new Error(
        'No local model downloaded. Download a model in settings first.',
      );
    }
    const { id, promise: runPromise } = call(
      'run',
      [
        {
          modelPath,
          prompt: args.prompt,
          systemPrompt: args.systemPrompt,
          gpu: process.platform === 'darwin' ? 'auto' : false,
          contextSize: resolveContextSize(args.modelId),
          options: {},
        },
      ],
      (info) => {
        if (info?.text) onToken(info.text);
      },
    );
    activeRunId = id;
    try {
      return await runPromise;
    } finally {
      if (activeRunId === id) activeRunId = null;
    }
  })();

  const cancel = () => {
    if (activeRunId != null) {
      // Fire-and-forget cancel; the run promise rejects via the worker abort.
      call('cancel', [{ targetId: activeRunId }]).promise.catch(() => undefined);
    }
  };
  return { promise, cancel };
}

/**
 * Preload (warm) a model in the worker so the first chat/recall doesn't pay the
 * multi-GB load. Resolves false if the model file isn't downloaded yet. The
 * worker caches by path, so this is the single place the model loads in RAM —
 * shared by recall (runLocal) and the legacy chat facade (LLMService).
 */
export async function warmLocalModel(modelId?: string): Promise<boolean> {
  const modelPath = await resolveModelPath(modelId);
  if (!modelPath) return false;
  await call('warm', [
    {
      modelPath,
      gpu: process.platform === 'darwin' ? 'auto' : false,
      contextSize: resolveContextSize(modelId),
    },
  ]).promise;
  return true;
}

/** Pre-fork the worker so the first real query doesn't pay spawn cost. */
export function startLocalLlmWorker(): void {
  ensureChild().catch((e) => {
    console.warn('[llm] worker prefork failed:', e?.message ?? e);
  });
}

/** Kill the worker on app shutdown. */
export function stopLocalLlmWorker(): void {
  rejectAllPending(new Error('local llm worker stopping'));
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  child = null;
  starting = null;
}
