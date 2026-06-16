/**
 * Main-process client for the embedding worker (ai/workers/embedding-worker.js).
 *
 * Forks one `utilityProcess` that holds the EmbeddingGemma model and runs the
 * embed compute, so the ~334 MB model + per-chunk embedding never block the main
 * thread and stay isolated from the chat model. Mirrors localLlmClient.ts:
 * strips dev loader envs, injects the Apple-Silicon Metal guardrails into the
 * worker env, gives the JS heap headroom, correlates request/response by id, and
 * auto-respawns if the worker dies.
 */
import fs from 'fs';
import path from 'path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { getAppleMetalWorkaroundEnv } from '../../appleMetalGuardrails';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './embedding-constants';

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

let child: UtilityProcess | null = null;
let starting: Promise<UtilityProcess> | null = null;
let seq = 0;
let workerReady = false;
const pending = new Map<number, Pending>();

function workerPath(): string {
  const candidates = [
    path.join(process.cwd(), 'src/main/ai/workers/embedding-worker.js'),
    // Packaged build: CopyWebpackPlugin emits the worker to
    // dist/main/ai/workers (__dirname = dist/main). This is the one that fixes
    // the prod ERR_MODULE_NOT_FOUND — none of the others exist in the package.
    path.join(__dirname, 'ai/workers/embedding-worker.js'),
    path.join(__dirname, '../workers/embedding-worker.js'),
    path.join(__dirname, 'workers/embedding-worker.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return './src/main/ai/workers/embedding-worker.js';
}

function rejectAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function handleMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'result') p.resolve(msg.value);
  else if (msg.type === 'error')
    p.reject(new Error(msg.message || 'embedding worker error'));
}

function ensureChild(): Promise<UtilityProcess> {
  if (child) return Promise.resolve(child);
  if (starting) return starting;
  starting = new Promise<UtilityProcess>((resolve, reject) => {
    let proc: UtilityProcess;
    try {
      const workerEnv: NodeJS.ProcessEnv = { ...process.env };
      delete workerEnv.NODE_OPTIONS;
      delete workerEnv.ELECTRON_RUN_AS_NODE;
      // node-llama-cpp loads in the worker → it needs the Apple-Silicon Metal
      // guardrails in its env (no-op off macOS-arm64).
      Object.assign(workerEnv, getAppleMetalWorkaroundEnv(workerEnv));
      proc = utilityProcess.fork(workerPath(), [], {
        serviceName: 'constella-embedding-worker',
        stdio: 'pipe',
        env: workerEnv,
        // Embedding a big corpus churns the JS heap; give it headroom (the model
        // itself is native memory, separate from this).
        execArgv: ['--js-flags=--max-old-space-size=4096'],
      });
      // Route the worker's stdout/stderr through console.* (NOT
      // process.std*.write) so the diagnostics file-log tee captures them.
      // node-llama-cpp / llama.cpp print the real model-load / abort reason to
      // stderr; in a packaged build process.stderr goes nowhere, which is why a
      // crash here only ever surfaced as an opaque "exited (code 1)".
      proc.stdout?.on('data', (d: Buffer) =>
        console.log(`[embed-worker] ${String(d).trimEnd()}`),
      );
      proc.stderr?.on('data', (d: Buffer) =>
        console.error(`[embed-worker:err] ${String(d).trimEnd()}`),
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
        workerReady = true;
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
      workerReady = false;
      rejectAllPending(new Error(`embedding worker exited (code ${code})`));
      if (!ready) reject(new Error(`embedding worker exited (code ${code})`));
      // eslint-disable-next-line no-console
      console.warn('[embed] worker exited', code, '— will respawn on next call');
    });
  });
  return starting;
}

function call(method: string, args: any[]): Promise<any> {
  const id = (seq += 1);
  return (async () => {
    const proc = await ensureChild();
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        proc.postMessage({ type: 'call', id, method, args });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  })();
}

/** Embed one string in the worker. Returns a 512-dim number[] or null on failure. */
export async function embedViaWorker(
  modelPath: string,
  text: string,
  kind: 'query' | 'document',
  title?: string | null,
): Promise<number[] | null> {
  try {
    const r = await call('embed', [
      {
        modelPath,
        text,
        kind,
        title,
        dim: EMBEDDING_DIM,
        contextSize: EMBEDDING_MODEL.contextSize,
      },
    ]);
    return r?.vector ?? null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[embed] worker embed failed:', e);
    return null;
  }
}

/** Preload (warm) the model in the worker. Resolves true once it's ready. */
export async function warmEmbeddingWorker(modelPath: string): Promise<boolean> {
  try {
    await call('warm', [{ modelPath, contextSize: EMBEDDING_MODEL.contextSize }]);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[embed] worker warm failed:', e);
    return false;
  }
}

export function embeddingWorkerReady(): boolean {
  return workerReady;
}

export function stopEmbeddingWorker(): void {
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  child = null;
  starting = null;
  workerReady = false;
  rejectAllPending(new Error('embedding worker stopped'));
}
