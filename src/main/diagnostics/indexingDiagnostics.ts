/**
 * Production diagnostics for local indexing.
 *
 * Packaged builds have no terminal, and the file-index / file-graph engines log
 * via raw `console.*` — so in production that output is dropped (electron-log's
 * main.log only captures explicit `log.*` calls). When a user reports "I set up
 * indexing but nothing shows up," there is nothing to inspect after the fact.
 *
 * This module fixes that with two pieces, both writing to files under the app's
 * userData dir (stable, known location the user can grab after a build):
 *
 *   1. initEngineFileLog() — tees every console.{log,info,warn,error,debug}
 *      line into `<userData>/logs/engine-<date>.log`, preserving the original
 *      console. So all the existing engine console calls now persist on disk in
 *      production with zero per-call-site edits.
 *
 *   2. dumpIndexingDiagnostics() — queries the live state of the indexing
 *      pipeline (file-index sources + their sync status/errors, main-db note
 *      counts, LanceDB vector totals, file-graph docs/concepts/themes) and
 *      writes a single greppable markdown snapshot to
 *      `<userData>/diagnostics/indexing-report.md`. Run at boot and on demand
 *      (IPC `file-index:diagnostics`). This is what tells "never indexed" apart
 *      from "indexed but ranked out of the recents window."
 */
import { app, ipcMain, crashReporter } from 'electron';
import fs from 'fs';
import path from 'path';

import { BACKEND_URL } from '../constants';

// ---------------------------------------------------------------------------
// 1. Console → file tee (persist engine logs in packaged builds)
// ---------------------------------------------------------------------------

let engineLogStream: fs.WriteStream | null = null;
let engineLogPath = '';
let consoleHooked = false;

/** Resolve the engine log file path without creating it (for the report header). */
export function getEngineLogPath(): string {
  if (engineLogPath) return engineLogPath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(dir, `engine-${day}.log`);
  } catch {
    return '';
  }
}

/**
 * Tee console output into a dated file under userData/logs. Idempotent. The
 * original console methods are cached and still called, so terminal output in
 * dev is unchanged and there is no recursion. Write failures are swallowed so
 * logging can never crash the app.
 */
export function initEngineFileLog(): string {
  if (consoleHooked) return engineLogPath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    engineLogPath = path.join(dir, `engine-${day}.log`);
    engineLogStream = fs.createWriteStream(engineLogPath, { flags: 'a' });
    engineLogStream.on('error', () => {
      /* disk full / EPIPE — never crash on logging */
    });
  } catch {
    return ''; // couldn't open the file — leave console untouched
  }

  const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
  ];
  for (const level of levels) {
    // Cache the real method so we still print AND avoid any recursion.
    const original = (console as any)[level]?.bind(console);
    (console as any)[level] = (...args: any[]) => {
      try {
        original?.(...args);
      } catch {
        /* ignore */
      }
      try {
        const line = args
          .map((a) =>
            typeof a === 'string'
              ? a
              : a instanceof Error
                ? `${a.message}\n${a.stack ?? ''}`
                : safeStringify(a),
          )
          .join(' ');
        engineLogStream?.write(
          `${new Date().toISOString()} [${level.toUpperCase()}] ${line}\n`,
        );
      } catch {
        /* ignore */
      }
    };
  }
  consoleHooked = true;
  // Use the original path through the (now-teed) console so the banner lands in
  // both the terminal and the file.
  console.log(`[diagnostics] engine console log → ${engineLogPath}`);
  return engineLogPath;
}

// ---------------------------------------------------------------------------
// 1b. Crash monitoring — capture the crashes that console logging can't see
// ---------------------------------------------------------------------------

/**
 * Install the last-resort crash/error nets. Without these, a native crash
 * (PDF-expand GPU/pdfium fault, LanceDB / node-llama-cpp abort) or an unhandled
 * rejection exits the process leaving nothing in any log. Everything here routes
 * through console.error (teed to the engine log) and/or Crashpad. Call ONCE,
 * as early as possible in main (before the first window).
 */
export function installCrashMonitoring(): void {
  // Native minidumps → <userData>/Crashpad. uploadToServer:false keeps them
  // local so we can symbolicate after the fact; this is the ONLY thing that
  // captures a GPU/pdfium renderer crash or a native llama/lance abort.
  try {
    crashReporter.start({ uploadToServer: false });
  } catch {
    /* crashReporter unavailable — non-fatal */
  }

  // Main-process JS safety net. Log-and-survive: an unhandled rejection would
  // otherwise terminate with only a terse stderr line that's lost in packaged
  // builds.
  process.on('uncaughtException', (err: any) => {
    console.error(`[uncaughtException] ${err?.stack || err?.message || err}`);
  });
  process.on('unhandledRejection', (reason: any) => {
    console.error(
      `[unhandledRejection] ${reason?.stack || reason?.message || reason}`,
    );
  });

  // Renderer death — THE hook for the "double-click a PDF → app shuts down"
  // crash. Fires in MAIN when any renderer frame dies, with the reason
  // (crashed / oom / launch-failed / killed) + exitCode. reason='oom' confirms
  // a big-PDF memory crash; reason='crashed' on a GPU/utility child points at
  // pdf.js/pdfium.
  app.on('render-process-gone', (_e, _wc, details: any) => {
    console.error(
      `[render-process-gone] reason=${details?.reason} exitCode=${details?.exitCode}`,
    );
  });
  app.on('child-process-gone', (_e, details: any) => {
    console.error(
      `[child-process-gone] type=${details?.type} name=${details?.name ?? ''} ` +
        `reason=${details?.reason} exitCode=${details?.exitCode}`,
    );
  });

  // Catchable renderer errors (window.onerror / unhandledrejection) forwarded
  // over IPC by the renderer bootstrap — the only way a renderer-side error
  // reaches the persisted engine log, since a crashing renderer never emits a
  // 'console-message'.
  ipcMain.on('app:renderer-error', (_e, payload: any) => {
    const msg =
      payload && typeof payload === 'object' && 'msg' in payload
        ? payload.msg
        : typeof payload === 'string'
          ? payload
          : safeStringify(payload);
    console.error(`[renderer-error] ${msg}`);
  });
}

/** JSON.stringify that never throws (circular refs, BigInt, etc.). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Queried state snapshot
// ---------------------------------------------------------------------------

/** Run `fn`, returning its value or a short error string — so one failing
 *  query never blanks the whole report. */
async function safe<T>(label: string, fn: () => Promise<T> | T): Promise<T | string> {
  try {
    return await fn();
  } catch (e: any) {
    return `ERROR (${label}): ${e?.message ?? e}`;
  }
}

/**
 * Gather the full indexing-pipeline state. Every stage is wrapped so a single
 * failure degrades to an inline error line instead of aborting the snapshot.
 */
async function gatherIndexingDiagnostics(): Promise<string> {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`# Indexing diagnostics — ${ts}`);
  push();

  // --- environment / profile ---
  push('## Environment');
  push(`- app version: ${safeCall(() => app.getVersion())}`);
  push(`- userData: ${safeCall(() => app.getPath('userData'))}`);
  push(`- engine log: ${getEngineLogPath()}`);
  push(`- backend: ${BACKEND_URL}`);
  push(`- platform: ${process.platform} (electron ${process.versions.electron})`);
  push();

  // --- file-index sources (the #1 signal: did a sync run / error?) ---
  push('## File-index sources');
  const sources = await safe('sources', async () => {
    const { listSourcesSync } = require('../file-index/sources');
    return listSourcesSync();
  });
  if (typeof sources === 'string') {
    push(sources);
  } else if (!Array.isArray(sources) || sources.length === 0) {
    push('- (no sources configured)');
  } else {
    for (const s of sources as any[]) {
      push(`- **${s.name}** (${s.kind}) — \`${s.path}\``);
      push(
        `    syncEnabled=${s.syncEnabled} inProgress=${s.inProgress ?? false} ` +
          `lastDocCount=${s.lastDocCount ?? '—'}`,
      );
      push(
        `    lastSyncStartedAt=${fmtTime(s.lastSyncStartedAt)} ` +
          `lastSyncedAt=${fmtTime(s.lastSyncedAt)} ` +
          `lastFullSyncAt=${fmtTime(s.lastFullSyncAt)}`,
      );
      if (s.progress) push(`    progress=${safeStringify(s.progress)}`);
      if (s.lastError) push(`    ⚠️ lastError: ${s.lastError}`);
    }
  }
  push();

  // --- main-db (the Library reads these tables) ---
  // NOTE: require() with a LITERAL string path so webpack resolves it into the
  // bundle. A variable path (the old safeRequire helper) bundled to a runtime
  // require that always threw → every count showed "not a function".
  push('## main-db (Library tables)');
  push(`- notes total:       ${await safe('notesCount', () => require('../main-db/api').notesCount())}`);
  push(`- note_bodies total: ${await safe('noteBodiesCount', () => require('../main-db/api').noteBodiesCount())}`);
  push(`- canvases total:    ${await safe('canvasesCount', () => require('../main-db/api').canvasesCount())}`);
  const localFileNotes = await safe('localFileNotes', async () => {
    const ids = await require('../main-db/api').notesFindIdsByIntegration([
      'local',
      'obsidian',
    ]);
    return Array.isArray(ids) ? ids.length : 0;
  });
  push(`- local-file notes (integration local/obsidian): ${localFileNotes}`);
  push(
    '    ↳ if this is > 0 but they are not in the Library grid, they are indexed but ' +
      'ranked out of the recents window (cards sort by file mtime, capped ~100).',
  );
  push();

  // --- LanceDB (vector store the search uses) ---
  push('## LanceDB vectors');
  const lance = await safe('lanceStats', async () => {
    const { getLanceDBStats } = require('../utils/vector-db/vector-db');
    return getLanceDBStats();
  });
  push(typeof lance === 'string' ? lance : `- ${safeStringify(lance)}`);
  push();

  // --- file-graph engine (concepts/themes built from indexed docs) ---
  push('## File-graph engine');
  const graph = await safe('fileGraph', async () => {
    const { inspectFileGraph } = require('../file-graph/inspect');
    // inspectFileGraph prints + writes its own file-graph/inspect-report.md;
    // we embed the full report here so everything is in one snapshot.
    return inspectFileGraph(ts);
  });
  push(typeof graph === 'string' ? graph : safeStringify(graph));
  push();

  return lines.join('\n');
}

function safeCall(fn: () => string): string {
  try {
    return fn();
  } catch (e: any) {
    return `(${e?.message ?? e})`;
  }
}
function fmtTime(ms?: number): string {
  if (!ms || typeof ms !== 'number') return '—';
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/**
 * Gather the snapshot and write it to `<userData>/diagnostics/indexing-report.md`
 * (latest, overwritten) plus a timestamped copy. Returns the report text.
 * `reason` is recorded for context (boot / ipc / etc.).
 */
export async function dumpIndexingDiagnostics(reason = 'manual'): Promise<string> {
  const report = await gatherIndexingDiagnostics();
  try {
    const dir = path.join(app.getPath('userData'), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const latest = path.join(dir, 'indexing-report.md');
    const dated = path.join(dir, `indexing-report-${stamp}.md`);
    const body = `<!-- reason: ${reason} -->\n${report}\n`;
    fs.writeFileSync(latest, body, 'utf8');
    fs.writeFileSync(dated, body, 'utf8');
    console.log(`[diagnostics] indexing report (${reason}) → ${latest}`);
  } catch (e: any) {
    console.warn('[diagnostics] could not write indexing report:', e?.message ?? e);
  }
  return report;
}

/** IPC `file-index:diagnostics` → run a dump on demand (devtools / a button). */
export function registerDiagnosticsIpc(): void {
  ipcMain.handle('file-index:diagnostics', async () =>
    dumpIndexingDiagnostics('ipc'),
  );
}

/**
 * Run one snapshot ~60s after boot, by when the file-index loop + LanceDB have
 * had a chance to initialize, so every production launch leaves a fresh report
 * on disk without any user action.
 */
export function scheduleBootDiagnostics(delayMs = 60_000): void {
  setTimeout(() => {
    dumpIndexingDiagnostics('boot').catch(() => undefined);
  }, delayMs);
}
