/**
 * Main-thread supervisor for the main-DB worker (see ./worker.ts).
 *
 * Owns the worker_thread lifecycle and exposes ONE async entry point,
 * callRepo(), used by both the IPC bridge (renderer calls) and the typed
 * facade in ./api.ts (main-side callers like file-index). Requests are
 * correlated by id; write responses carry a `change` envelope which we
 * broadcast to every window AFTER the write committed.
 *
 * The worker auto-respawns on crash (pending calls reject); docs cross this
 * boundary as raw JSON strings only.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

import type { DbCollection, DbWorkerResponse } from '../../shared/main-db-api';
import { emitDbChanged } from './changes';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** webContents.id of the requesting renderer; -1 for main-side callers. */
  origin: number;
};

let worker: any | null = null;
let starting: Promise<any> | null = null;
let closing = false;
let seq = 0;
const pending = new Map<number, Pending>();

export function mainDbDir(): string {
  return path.join(app.getPath('userData'), 'main-db');
}

/**
 * Resolve the worker entry. The worker subtree is plain CJS .js (loaders like
 * tsx don't reach worker threads): dev loads the source file in-place,
 * packaged builds load the webpack-bundled db-worker.js next to main.js.
 */
function workerEntryPath(): string {
  const candidates = [
    // Packaged / prod build: dist/main/db-worker.js (webpack entry).
    path.join(__dirname, 'db-worker.js'),
    path.join(__dirname, '..', 'db-worker.js'),
    // Dev: run the plain-JS source in-place (__dirname = src/main/main-db).
    path.join(__dirname, 'worker.js'),
    path.join(process.cwd(), 'src/main/main-db/worker.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('[main-db] could not locate the db worker entry');
}

function rejectAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function handleResponse(msg: DbWorkerResponse): void {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) {
    // Broadcast after the commit so renderers never observe a phantom change.
    if (msg.change && msg.change.ids.length > 0) {
      emitDbChanged({ ...msg.change, origin: p.origin });
    }
    p.resolve(msg.data);
  } else {
    p.reject(new Error(msg.error || 'main-db worker error'));
  }
}

function ensureWorker(): Promise<any> {
  if (worker) return Promise.resolve(worker);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    let w: any;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { Worker } = require('worker_threads');
      w = new Worker(workerEntryPath(), {
        workerData: { dbDir: mainDbDir() },
      });
    } catch (e) {
      starting = null;
      reject(e);
      return;
    }
    let ready = false;
    w.on('message', (msg: any) => {
      if (!ready && msg?.type === 'ready') {
        ready = true;
        worker = w;
        starting = null;
        resolve(w);
        return;
      }
      if (msg?.type === 'closed') return; // handled by closeMainDb's waiter
      handleResponse(msg);
    });
    w.on('error', (err: Error) => {
      console.error('[main-db] worker error:', err);
      if (!ready) {
        starting = null;
        reject(err);
      }
    });
    w.on('exit', (code: number) => {
      worker = null;
      rejectAllPending(new Error(`main-db worker exited (code ${code})`));
      if (!ready) {
        starting = null;
        reject(new Error(`main-db worker exited during startup (code ${code})`));
      } else if (!closing) {
        console.error(`[main-db] worker died (code ${code}) — will respawn on next call`);
      }
    });
  });
  return starting;
}

/**
 * Run one repo method in the db worker. `origin` is the webContents.id of the
 * requesting renderer (echo suppression for db:changed) — omit for main-side
 * callers.
 */
export async function callRepo<T = unknown>(
  collection: DbCollection,
  method: string,
  args: unknown[] = [],
  origin: number = -1,
): Promise<T> {
  const w = await ensureWorker();
  seq += 1;
  const id = seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, origin });
    try {
      w.postMessage({ id, collection, method, args });
    } catch (e) {
      pending.delete(id);
      reject(e as Error);
    }
  });
}

/** Drain + checkpoint + stop the worker. Called from app 'will-quit'. */
export async function closeMainDb(): Promise<void> {
  const w = worker;
  if (!w) return;
  closing = true;
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000); // don't hold up quit forever
      w.once('message', (msg: any) => {
        if (msg?.type === 'closed') {
          clearTimeout(timeout);
          resolve();
        }
      });
      w.postMessage({ type: 'close' });
    });
  } catch {
    /* best-effort */
  }
  try {
    await w.terminate();
  } catch {
    /* already gone */
  }
  worker = null;
  closing = false;
}

/** Stop the worker and delete the DB directory — reset-app only. */
export async function deleteMainDb(): Promise<void> {
  await closeMainDb();
  try {
    fs.rmSync(mainDbDir(), { recursive: true, force: true });
  } catch (e) {
    console.error('[main-db] failed to delete db dir:', e);
  }
}
