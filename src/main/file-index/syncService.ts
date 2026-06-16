/**
 * File-index sync service (main process) — the de-qmd'd replacement for
 * agents-slack's qmdService.ts. For each registered source it:
 *   1. walks the folder and diffs file mtime/size against a persisted manifest,
 *   2. extracts + chunks each new/changed file,
 *   3. embeds the parent + chunks with the app's shared embedding model
 *      (EmbeddingGemma, 512-dim, via createEmbedding),
 *   4. writes the vectors straight into LanceDB, and
 *   5. streams the built NoteRxdbData / NoteBodyRxdbData records to the renderer
 *      (which owns RxDB) via `file-index:records` — deletions go via
 *      `file-index:deletions`.
 *
 * Storage split note: LanceDB lives in main (we write it directly); RxDB lives
 * in the renderer, so its writes are delegated over IPC. Embedding reuses the
 * already-loaded main-process model (createEmbedding) rather than loading a
 * second copy — we yield between files to keep the event loop responsive.
 */
import { app } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
// CommonJS module — same import style file-embedding-handler.ts uses.
import { createEmbedding } from '../ai/create-embedding';
import {
  removeMultipleFromLanceDB,
  syncVectorsToLanceDB,
  createIndexIfNeeded,
  optimizeLanceDB,
} from '../utils/vector-db/vector-db';
import { isRecallActive } from '../providers/runner';
import { chunkDocument, parentEmbedText } from './chunker';
import { extractToText, TEXT_EXTENSIONS } from './extractors';
import { buildFileRecords, chunkId, parentIdForPath } from './records';
import { parseWikilinks, buildWikilinkEnvelopes } from './wikilinks';
import {
  noteBodiesBulkRemove,
  noteBodiesBulkUpsert,
  notesBulkRemove,
  notesBulkUpsert,
} from '../main-db/api';
import {
  applyGraphConnectionEnvelopes,
  pruneStaleWikilinkEdges,
} from '../main-db/graphConnections';
import { removeGraphDocs } from '../file-graph/textStore';
import { addOutgoingEdges, removeEdgesByIds } from '../file-graph/edgeStore';
import type { GraphConnection } from '../../models/GraphConnection';
import {
  IndexedSource,
  COMMON_IGNORE_DIRS,
  getSource,
  indexableExtensions,
  listSources,
  updateSource,
  updateSourceProgress,
} from './sources';

const RENDERER_BATCH = 25; // notes per `file-index:records` event
const MAX_FILES_PER_SOURCE = 20000; // hard cap so a huge root can't run away
// Skip individual files larger than this (50 MB). PDF/DOCX/XLSX parsing scales
// with size; a pathological file would otherwise hang the whole sync (which
// holds the per-source mutex), freezing all indexing. (agents-slack MAX_FILE_BYTES)
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const STALE_LOCK_MS = 60_000;
// If a prior sync for the same source is still running, wait at most this long
// for it before giving up — never await a hung sync forever (which would freeze
// the loop). (agents-slack MUTEX_WAIT_MS)
const MUTEX_WAIT_MS = 30_000;
const RECALL_INDEX_COOLDOWN_MS = 25_000;

// LanceDB leaves freshly-written rows OUT of the ANN index (they're brute-forced
// at query time) until optimize() folds them in + compacts the fragment files.
// We accumulate vectors written/removed across syncs and run a maintenance pass
// once enough has changed (LanceDB's guidance is to optimize after a large batch
// / many modification ops, not after every tiny edit).
const OPTIMIZE_AFTER_WRITES = 2000;
let writesSinceOptimize = 0;

export interface SyncResult {
  ran: boolean;
  indexed?: number;
  embedded?: number;
  deleted?: number;
  error?: string;
}

interface SyncOptions {
  force?: boolean;
  includeDisabled?: boolean;
}

interface ManifestEntry {
  mtimeMs: number;
  size: number;
  parentId: string;
  chunkCount: number;
  // Obsidian only: the `[[targets]]` parsed from this file's body, cached so the
  // post-sync backlinking pass can resolve links across the whole vault without
  // re-reading unchanged files. Optional → back-compat with old manifests.
  outgoingLinks?: string[];
}
type Manifest = Record<string, ManifestEntry>; // keyed by absolute path

const syncMutex = new Map<string, Promise<SyncResult>>();
// Resolved folder paths with a sync currently running. Guards against two
// DIFFERENT source rows that point at the same folder syncing at once (which
// would double-walk + double-embed the same files). The per-source mutex above
// can't catch this because it's keyed by source id, not path.
const pathInFlight = new Set<string>();
const cancelled = new Set<string>();

// --- renderer bridge (lazy require avoids a main.ts <-> syncService cycle) ---
function emit(channel: string, payload: any): void {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { mainWindow } = require('../main');
    mainWindow?.webContents?.send(channel, payload);
  } catch {
    /* window gone / not ready */
  }
}

// --- manifest persistence ------------------------------------------------
function manifestPath(sourceId: string): string {
  return path.join(app.getPath('userData'), 'file-index', `${sourceId}.json`);
}

async function readManifest(sourceId: string): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath(sourceId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeManifest(sourceId: string, m: Manifest): Promise<void> {
  const p = manifestPath(sourceId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m), 'utf8');
  await fs.rename(tmp, p);
}

// --- folder walk ----------------------------------------------------------
interface ScannedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * POSITIVE accept gate for filenames — only index files whose name looks like
 * human-authored content. This is the agents-slack philosophy: rather than
 * chasing an ever-growing denylist of build/package dirs, only accept names
 * that read like real notes/docs. Rejects the junk that floods a code repo:
 *   - content hashes / git objects / build IDs  (e.g. C98127B06B9E, 4E8B94ED1F82)
 *   - all-caps package metadata                  (LICENSE, README, NOTICE, RECORD)
 *   - pure dates / numbers                       (2022-10-19, 545505504662)
 * Keeps real names: "civil-war-leaders", "01-architecture", "paywall-first",
 * "auth_check_syncing_flow".
 */
function looksLikeContentName(fileName: string): boolean {
  const base = fileName.replace(/\.[^.]+$/, ''); // strip extension
  if (!base) return false;
  // Pure hex token (git/build/content hash): all hex chars, 6+ long.
  if (/^[0-9a-fA-F]{6,}$/.test(base)) return false;
  // Must contain a real lowercase word (2+ consecutive lowercase letters).
  // This rejects hashes, ALL-CAPS metadata, and numeric/date names in one shot.
  return /[a-z]{2,}/.test(base);
}

// Build-manifest filenames that mark a directory as a CODE PROJECT, not a
// knowledge folder. When a dir contains one of these we skip its whole subtree
// (a repo's README / docs / dataset .txt are not the user's notes). We do NOT
// use `.git` as a marker — people often git-version their note vaults.
const PROJECT_MARKER_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'Podfile',
  'Package.swift',
  'Gemfile',
  'composer.json',
  'CMakeLists.txt',
]);

/** True when this directory's entries include a code-project marker — either a
 *  marker file (package.json, settings.gradle, …) or an Xcode project bundle
 *  (`*.xcodeproj` / `*.xcworkspace`, which are directories). */
function isCodeProjectDir(entries: fsSync.Dirent[]): boolean {
  for (const ent of entries) {
    if (ent.isFile() && PROJECT_MARKER_FILES.has(ent.name)) return true;
    if (
      ent.isDirectory() &&
      (ent.name.endsWith('.xcodeproj') || ent.name.endsWith('.xcworkspace'))
    ) {
      return true;
    }
  }
  return false;
}

/** True for macOS TCC / Full-Disk-Access style permission denials. */
function isPermissionError(e: any): boolean {
  const code = e?.code ?? '';
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    /not permitted|operation not permitted|permission denied/i.test(
      e?.message ?? '',
    )
  );
}

/** Recursively collect indexable files under the source, honoring its
 *  extension whitelist + ignored directory names. Skips dotfiles/dirs and files
 *  over MAX_FILE_BYTES. Reports `permDenied` so the caller can surface an FDA
 *  hint instead of silently indexing zero files. */
async function walkSource(
  source: IndexedSource,
): Promise<{ files: ScannedFile[]; permDenied: boolean }> {
  const exts = new Set(indexableExtensions(source).map((e) => e.toLowerCase()));
  // ALWAYS apply the current baseline ignore set, unioned with whatever this
  // source persisted at creation — otherwise existing sources keep their old
  // (thin) list and code-build dirs (build/venv/target/...) leak back in.
  const skipDirs = new Set([
    ...COMMON_IGNORE_DIRS,
    ...(source.ignoreDirs ?? []),
  ]);
  const sourceRoot = path.resolve(source.path);
  const out: ScannedFile[] = [];
  let permDenied = false;

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES_PER_SOURCE) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      // macOS denies reading a TCC-protected folder (Documents/Downloads/…)
      // without Full Disk Access — flag it so the UI can prompt for FDA.
      if (isPermissionError(e)) permDenied = true;
      return; // transient/other errors — skip this dir
    }
    // Skip code-project subtrees (but never the source root itself — the user
    // may have pointed a source straight at a repo on purpose).
    if (path.resolve(dir) !== sourceRoot && isCodeProjectDir(entries)) {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES_PER_SOURCE) return;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!exts.has(path.extname(ent.name).toLowerCase())) continue;
      // Positive content-name gate — keep build/package/hash junk out without a
      // dir denylist (e.g. .dist-info/top_level, git object hashes, build IDs).
      if (!looksLikeContentName(ent.name)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_FILE_BYTES) continue; // skip giant files — parsing can hang the sync
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* skip */
      }
    }
  }

  await walk(path.resolve(source.path));
  return { files: out, permDenied };
}

// --- embedding (reuse the single main-process model) ---------------------
// Embed via the shared local model. CRUCIAL: never let a rejection escape — the
// embed worker can crash mid-run ("embedding worker exited"), and an unhandled
// throw here aborts the ENTIRE sync pass before the manifest is written, so the
// next pass re-processes every file (the "never converges" loop). Treat a crash
// exactly like a null result: skip this file, count it as a failure, keep going.
async function embed(text: string): Promise<number[] | null> {
  try {
    const v = await createEmbedding(text);
    return v ? Array.from(v as ArrayLike<number>) : null;
  } catch (e: any) {
    console.warn('[file-index] embed failed (worker crash?):', e?.message ?? e);
    return null;
  }
}

const yieldToLoop = () =>
  new Promise<void>((r) => {
    setImmediate(r);
  });

/**
 * Sync one source if dirty/due. Concurrent calls coalesce on the mutex.
 */
export async function syncSource(
  sourceId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  // Coalesce concurrent calls — but never await a hung prior sync forever (a
  // stuck file/model-load would otherwise freeze the whole loop). Give up after
  // MUTEX_WAIT_MS; the stale-lock check will recover the source on a later tick.
  const existing = syncMutex.get(sourceId);
  if (existing) {
    const raced = await Promise.race([
      existing.then((r) => ({ kind: 'done' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) =>
        setTimeout(() => res({ kind: 'timeout' }), MUTEX_WAIT_MS),
      ),
    ]);
    if (raced.kind === 'timeout') {
      return {
        ran: false,
        error: 'previous sync still in progress (waited 30s)',
      };
    }
    return raced.r;
  }

  // Path-level guard (defense-in-depth on top of the registry's path-dedup):
  // never let two sources that resolve to the same folder sync concurrently.
  const src0 = await getSource(sourceId);
  const resolvedPath = src0 ? path.resolve(src0.path) : '';
  if (resolvedPath && pathInFlight.has(resolvedPath)) {
    return {
      ran: false,
      error: 'another source for this path is already syncing',
    };
  }
  if (resolvedPath) pathInFlight.add(resolvedPath);

  const work = (async (): Promise<SyncResult> => {
    const source = await getSource(sourceId);
    if (!source) return { ran: false, error: 'source not found' };
    if (isRecallActive(RECALL_INDEX_COOLDOWN_MS)) {
      return { ran: false, error: 'deferred while recall is active' };
    }
    if (!fsSync.existsSync(source.path)) {
      await updateSource(sourceId, {
        lastError: `path missing: ${source.path}`,
      });
      return { ran: false, error: 'path missing' };
    }

    // Interval / dirty gate (skipped on force). The full mtime diff below is
    // the real change check; this just avoids walking too often.
    const staleInProgress =
      source.inProgress &&
      source.lastSyncStartedAt &&
      Date.now() - (source.progress?.updatedAt ?? source.lastSyncStartedAt) >
        STALE_LOCK_MS;
    if (!opts.force && !staleInProgress && source.lastFullSyncAt) {
      const intervalMs = (source.syncIntervalMin ?? 10) * 60_000;
      if (Date.now() - source.lastFullSyncAt < intervalMs) {
        // Still cheap-walk to detect a recent edit; if nothing newer, bail.
        const { files } = await walkSource(source);
        const newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
        if (newest <= source.lastFullSyncAt) return { ran: false };
      }
    }

    try {
      await updateSource(sourceId, {
        inProgress: true,
        lastSyncStartedAt: Date.now(),
        lastError: undefined,
      });

      const manifest = await readManifest(sourceId);
      const { files, permDenied } = await walkSource(source);

      // macOS Full Disk Access: the folder couldn't be read at all. Surface a
      // clear, FDA-triggering error (the Local Folders modal shows a "grant
      // access" banner on this) instead of silently "syncing" zero files.
      if (permDenied && files.length === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[file-index] "${source.name}" (${source.path}): permission denied — needs Full Disk Access`,
        );
        await updateSource(sourceId, {
          lastError:
            'macOS denied access to this folder. Grant Full Disk Access to Constella in System Settings → Privacy & Security → Full Disk Access.',
          inProgress: false,
          progress: undefined,
        });
        return { ran: false, error: 'permission denied (Full Disk Access)' };
      }

      const seen = new Set(files.map((f) => f.path));

      // Deleted = in manifest but no longer on disk.
      const deletedPaths = Object.keys(manifest).filter((p) => !seen.has(p));
      // Changed = new or mtime/size differs from manifest.
      const changed = files.filter((f) => {
        const prev = manifest[f.path];
        return !prev || prev.mtimeMs !== f.mtimeMs || prev.size !== f.size;
      });
      const unchangedCount = Math.max(0, files.length - changed.length);

      updateSourceProgress(sourceId, {
        scanned: unchangedCount,
        total: files.length,
        embedded: 0,
      });

      let indexed = 0;
      let embedded = 0;
      let embedFailures = 0; // files skipped because the embed model returned null
      let interrupted: 'cancelled' | 'recall' | null = null;
      let noteBatch: Record<string, any>[] = [];
      let bodyBatch: Record<string, any>[] = [];

      // eslint-disable-next-line no-console
      console.log(
        `[file-index] "${source.name}" (${source.path}): ${files.length} indexable file(s), ${changed.length} new/changed, ${deletedPaths.length} deleted`,
      );

      const flush = async () => {
        if (noteBatch.length === 0 && bodyBatch.length === 0) return;
        const notes = noteBatch;
        const noteBodies = bodyBatch;
        noteBatch = [];
        bodyBatch = [];
        // Write the records into the main DB directly (no renderer round-trip);
        // the emit below only feeds the renderer's minisearch index now.
        try {
          if (notes.length) {
            await notesBulkUpsert(notes.map((n) => JSON.stringify(n)));
          }
          if (noteBodies.length) {
            await noteBodiesBulkUpsert(
              noteBodies.map((b) => JSON.stringify(b)),
            );
          }
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[file-index] main-db write failed:', e?.message ?? e);
        }
        emit('file-index:records', { sourceId, notes, noteBodies });
      };

      // Obsidian backlinking: resolve the manifest's cached `[[ ]]` wikilinks
      // into typed `references` edges, applied straight onto the note records
      // in the main DB (same path the auto-connection engine uses).
      // Deterministic edge ids make this idempotent across syncs; envelopes
      // whose endpoints aren't indexed are dropped by the applier, so
      // unresolved links cost nothing. Called after a completed pass AND after
      // an interrupted one (manifest keeps pre-interruption entries, so a
      // partial first index still gets backlinks for what it indexed instead
      // of waiting for the first complete pass).
      const runWikilinkPass = async (): Promise<void> => {
        if (source.kind !== 'obsidian' || cancelled.has(sourceId)) return;
        try {
          const envelopes = buildWikilinkEnvelopes(manifest, source.path);
          if (envelopes.length) await applyGraphConnectionEnvelopes(envelopes);

          // Mirror the hard wikilink edges into the file-graph SQLite store so
          // (a) concept/theme clustering uses the vault's explicit link
          // structure and (b) the auto-connection engine's alreadyConnected()
          // dedup sees them — otherwise it re-classifies linked pairs and
          // overwrites the hard edge with an AI suggestion.
          const edgesBySource = new Map<string, GraphConnection[]>();
          for (const env of envelopes) {
            const edge: GraphConnection = {
              uniqueid: env.data.connectionId,
              source_id: env.source,
              target_id: env.target,
              type: 'references',
              strength: env.data.connectionStrength,
              context: env.data.connectionContext,
              sourceIntegration: env.data.sourceIntegration,
              createdAt: env.data.createdAt,
              is_ai_suggestion: false,
            };
            const list = edgesBySource.get(env.source);
            if (list) list.push(edge);
            else edgesBySource.set(env.source, [edge]);
          }
          for (const [srcId, edges] of edgesBySource) {
            addOutgoingEdges(srcId, edges);
          }

          // Reconcile: the resolution above is append-only, so strip any
          // previously-written wikilink edge whose `[[link]]` no longer exists
          // in the vault (link text deleted, or its file removed) — from the
          // note records AND the file-graph store, or the graph drifts from
          // the vault and alreadyConnected() keeps suppressing AI edges for
          // pairs that are no longer linked.
          const vaultIds = Object.entries(manifest).map(
            ([p, entry]) => entry.parentId || parentIdForPath(p),
          );
          const removedEdgeIds = await pruneStaleWikilinkEdges(
            vaultIds,
            envelopes,
          );
          if (removedEdgeIds.length) removeEdgesByIds(removedEdgeIds);

          // eslint-disable-next-line no-console
          console.log(
            `[file-index] "${source.name}" wikilinks: ${envelopes.length} backlink edge(s), ${removedEdgeIds.length} stale removed`,
          );
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[file-index] wikilink pass failed:', e?.message ?? e);
        }
      };

      for (const file of changed) {
        if (cancelled.has(sourceId)) {
          interrupted = 'cancelled';
          break;
        }
        if (isRecallActive(RECALL_INDEX_COOLDOWN_MS)) {
          interrupted = 'recall';
          break;
        }
        const outcome = await extractToText(file.path);
        if (!outcome.ok) {
          // Record an empty manifest entry so we don't retry an unreadable file
          // every tick; a future edit (mtime change) still re-attempts.
          manifest[file.path] = {
            mtimeMs: file.mtimeMs,
            size: file.size,
            parentId: parentIdForPath(file.path),
            chunkCount: 0,
            outgoingLinks: source.kind === 'obsidian' ? [] : undefined,
          };
          continue;
        }

        const parentVec = await embed(
          parentEmbedText(path.basename(file.path), outcome.text),
        );
        if (!parentVec) {
          // The local embed model returned null — it isn't ready yet (still
          // downloading/loading, or failed). Count it; we surface a clear error
          // + skip the false "completed" stamp below so it retries next tick.
          embedFailures += 1;
          continue;
        }

        const chunks = chunkDocument(outcome.text);
        const chunkVectors: number[][] = [];
        for (const c of chunks) {
          if (cancelled.has(sourceId)) {
            interrupted = 'cancelled';
            break;
          }
          if (isRecallActive(RECALL_INDEX_COOLDOWN_MS)) {
            interrupted = 'recall';
            break;
          }
          const v = await embed(c.text);
          chunkVectors.push(v ?? []);
        }
        if (interrupted) break;

        const built = buildFileRecords({
          source,
          absPath: file.path,
          mtimeMs: file.mtimeMs,
          text: outcome.text,
          parentVector: parentVec,
          chunks,
          chunkVectors,
        });

        // Vectors → LanceDB straight away (main owns it).
        await syncVectorsToLanceDB(built.lanceRows);
        // Records → renderer for RxDB write.
        noteBatch.push(built.note);
        bodyBatch.push(...built.noteBodies);

        // Main-side text copy for the knowledge-graph engine (which can't read
        // the renderer's RxDB). Best-effort; lazy require avoids a load cycle.
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
          const { putGraphDoc } = require('../file-graph/textStore');
          await putGraphDoc({
            parentId: built.parentId,
            title: built.note.title,
            path: file.path,
            text: outcome.text,
          });
        } catch {
          /* graph engine optional */
        }

        manifest[file.path] = {
          mtimeMs: file.mtimeMs,
          size: file.size,
          parentId: built.parentId,
          chunkCount: built.noteBodies.length,
          // Cache parsed wikilinks for obsidian vaults so the post-sync
          // backlinking pass can resolve them across the whole vault. Only
          // markdown/text files carry real links — a `[[ ]]` in PDF-extracted
          // text would be a false positive, so attachments cache none (they
          // still RESOLVE as link targets, e.g. `[[Paper.pdf]]`).
          outgoingLinks:
            source.kind === 'obsidian'
              ? TEXT_EXTENSIONS.includes(path.extname(file.path).toLowerCase())
                ? parseWikilinks(outcome.text)
                : []
              : undefined,
        };

        indexed += 1;
        embedded += 1 + built.noteBodies.length;
        updateSourceProgress(sourceId, {
          scanned: unchangedCount + indexed,
          total: files.length,
          embedded,
        });

        if (noteBatch.length >= RENDERER_BATCH) await flush();
        await yieldToLoop(); // breathe between files
      }
      await flush();

      if (interrupted) {
        // Backlink whatever DID get indexed before the interruption — the
        // manifest still holds all pre-interruption entries, so the pass is
        // complete for everything indexed so far and idempotent for the rest.
        if (indexed > 0) await runWikilinkPass();
        await writeManifest(sourceId, manifest);
        const reason =
          interrupted === 'recall'
            ? 'Paused indexing while recall is active; will resume automatically.'
            : 'Indexing cancelled; remaining files will retry on the next sync.';
        await updateSource(sourceId, {
          lastSyncedAt: Date.now(),
          lastError: interrupted === 'cancelled' ? reason : undefined,
          inProgress: false,
          progress: undefined,
        });
        console.log(
          `[file-index] "${source.name}" pass interrupted (${interrupted}): indexed ${indexed}; remaining files will retry`,
        );
        return { ran: true, indexed, embedded, deleted: 0, error: reason };
      }

      // Nudge the knowledge-graph engine so it clusters the new docs on its
      // next tick instead of waiting for its force interval.
      if (indexed > 0) {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
          const { notifyNewChunks } = require('../file-graph/scheduler');
          notifyNewChunks(indexed);
        } catch {
          /* graph engine optional */
        }
      }

      // Handle deletions: soft-delete vectors + tell renderer to drop RxDB rows.
      let deletedCount = 0;
      if (deletedPaths.length && !cancelled.has(sourceId)) {
        const lanceIds: string[] = [];
        const parentIds: string[] = [];
        const chunkIds: string[] = [];
        for (const p of deletedPaths) {
          const entry = manifest[p];
          const parentId = entry?.parentId ?? parentIdForPath(p);
          parentIds.push(parentId);
          lanceIds.push(parentId);
          const count = entry?.chunkCount ?? 0;
          for (let i = 0; i < count; i += 1) {
            const cid = chunkId(parentId, i);
            chunkIds.push(cid);
            lanceIds.push(cid);
          }
          delete manifest[p];
          deletedCount += 1;
        }
        try {
          await removeMultipleFromLanceDB(lanceIds);
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[file-index] lance delete failed:', e?.message ?? e);
        }
        // Remove the rows from the main DB directly; the emit only feeds the
        // renderer's minisearch removal now.
        try {
          if (parentIds.length) await notesBulkRemove(parentIds);
          if (chunkIds.length) await noteBodiesBulkRemove(chunkIds);
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[file-index] main-db delete failed:', e?.message ?? e);
        }
        // Also purge the graph engine's traces (doc text / processed marker /
        // edges) — otherwise reconcile resurrects deleted notes from leftover
        // graph docs on the next boot.
        await removeGraphDocs(parentIds);
        emit('file-index:deletions', { sourceId, parentIds, chunkIds });
      }

      // Backlink pass — the manifest now reflects adds + deletes. Links only
      // change when files do, so it's gated on actual adds/edits/deletes (or a
      // forced sync, as a manual escape hatch) — the reconcile inside reads
      // every vault note record, which is wasted work on a no-op tick.
      if (indexed > 0 || deletedCount > 0 || opts.force) {
        await runWikilinkPass();
      }

      await writeManifest(sourceId, manifest);

      // If every changed file was skipped because the embed model wasn't ready,
      // do NOT stamp lastFullSyncAt — that would (a) show a misleading "synced"
      // status with a doc count of 0 actually-embedded, and (b) trip the 10-min
      // interval gate so it wouldn't retry. Surface a clear error instead; the
      // next tick retries once EmbeddingGemma has loaded.
      const embeddedNothing =
        changed.length > 0 && indexed === 0 && embedFailures > 0;
      // eslint-disable-next-line no-console
      console.log(
        `[file-index] "${
          source.name
        }" pass done: indexed ${indexed}, embed failures ${embedFailures}${
          embeddedNothing
            ? ' — embed model not ready; will retry next sync'
            : ''
        }`,
      );
      if (embeddedNothing) {
        await updateSource(sourceId, {
          lastSyncedAt: Date.now(),
          lastError:
            'Embedding model not ready yet (loads on first use, ~334 MB). Indexing will start automatically once it finishes.',
          inProgress: false,
          progress: undefined,
        });
      } else {
        await updateSource(sourceId, {
          lastSyncedAt: Date.now(),
          lastFullSyncAt: Date.now(),
          // Actual indexed docs (manifest size), not the raw file count.
          lastDocCount: Object.keys(manifest).length,
          lastError: undefined,
          inProgress: false,
          progress: undefined,
        });
      }

      // LanceDB index maintenance. New vectors written above sit outside the ANN
      // index until we (a) build one once the store is large enough and (b)
      // optimize() to fold them in + compact. Both are idempotent + self-gated,
      // so we only pay the cost after a meaningful amount has changed.
      writesSinceOptimize += embedded + deletedCount;
      if (writesSinceOptimize >= OPTIMIZE_AFTER_WRITES) {
        writesSinceOptimize = 0;
        try {
          await createIndexIfNeeded(); // builds an IVF-PQ index past the row threshold
          await optimizeLanceDB(); // folds new rows into the index + compacts files
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[file-index] lance optimize failed:', e?.message ?? e);
        }
      }

      return { ran: true, indexed, embedded, deleted: deletedCount };
    } catch (e: any) {
      const message = e?.message || String(e);
      await updateSource(sourceId, { lastError: message, inProgress: false });
      return { ran: false, error: message };
    } finally {
      cancelled.delete(sourceId);
    }
  })();

  syncMutex.set(sourceId, work);
  try {
    return await work;
  } finally {
    if (syncMutex.get(sourceId) === work) syncMutex.delete(sourceId);
    if (resolvedPath) pathInFlight.delete(resolvedPath);
  }
}

/** Sync every enabled source serially (don't hammer the shared embed model). */
export async function syncAll(
  opts: SyncOptions = {},
): Promise<Array<{ id: string; ran: boolean; error?: string }>> {
  const sources = await listSources();
  const out: Array<{ id: string; ran: boolean; error?: string }> = [];
  // Dedupe by resolved path so duplicate registry rows for the same folder
  // don't each trigger a full (redundant) walk + embed of it. Belt-and-
  // suspenders on top of the registry's path-dedup.
  const seenPaths = new Set<string>();
  for (const s of sources) {
    if (!s.syncEnabled && !opts.includeDisabled) continue;
    const rp = path.resolve(s.path);
    if (seenPaths.has(rp)) continue;
    seenPaths.add(rp);
    const r = await syncSource(s.id, opts);
    out.push({ id: s.id, ran: r.ran, error: r.error });
  }
  return out;
}

/** Cancel an in-flight sync (best-effort; the loop checks between files). */
export function cancelSource(sourceId: string): void {
  cancelled.add(sourceId);
}

/**
 * Drop every record a source produced: remove its LanceDB rows, tell the
 * renderer to delete the matching RxDB notes/chunks, and delete the manifest.
 * Called when the user removes a folder from the index.
 */
export async function purgeSource(sourceId: string): Promise<void> {
  cancelled.add(sourceId);
  const manifest = await readManifest(sourceId);
  const lanceIds: string[] = [];
  const parentIds: string[] = [];
  const chunkIds: string[] = [];
  for (const p of Object.keys(manifest)) {
    const entry = manifest[p];
    const parentId = entry?.parentId ?? parentIdForPath(p);
    parentIds.push(parentId);
    lanceIds.push(parentId);
    for (let i = 0; i < (entry?.chunkCount ?? 0); i += 1) {
      const cid = chunkId(parentId, i);
      chunkIds.push(cid);
      lanceIds.push(cid);
    }
  }
  if (lanceIds.length) {
    try {
      await removeMultipleFromLanceDB(lanceIds);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[file-index] purge lance delete failed:', e?.message ?? e);
    }
  }
  if (parentIds.length || chunkIds.length) {
    // Main DB rows go first; the emit feeds the renderer's minisearch removal.
    try {
      if (parentIds.length) await notesBulkRemove(parentIds);
      if (chunkIds.length) await noteBodiesBulkRemove(chunkIds);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(
        '[file-index] purge main-db delete failed:',
        e?.message ?? e,
      );
    }
    // Purge graph-engine traces too so reconcile can't resurrect these notes.
    await removeGraphDocs(parentIds);
    emit('file-index:deletions', { sourceId, parentIds, chunkIds });
  }
  try {
    await fs.rm(manifestPath(sourceId), { force: true });
  } catch {
    /* ignore */
  }
  cancelled.delete(sourceId);
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

// Renderer-ready handshake. The renderer's file-index coordinator owns RxDB and
// must be SUBSCRIBED to `file-index:records` before the first sync runs —
// otherwise the first index's emitted records hit a renderer that isn't
// listening and are lost forever (the manifest is written regardless, so a
// re-sync sees "0 changed" and never recovers them). The coordinator calls
// `file-index:renderer-ready` once subscribed; we gate the first pass on it.
let rendererReady = false;
let resolveRendererReady: () => void = () => {};
const rendererReadyPromise = new Promise<void>((resolve) => {
  resolveRendererReady = resolve;
});
export function markRendererReady(): void {
  if (rendererReady) return;
  rendererReady = true;
  resolveRendererReady();
}

/** Start the periodic sync loop (idempotent). Each source's own interval
 *  gates whether real work runs on a given tick. */
export function startFileIndexLoop(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    syncAll().catch(() => {
      /* per-source errors recorded on the source */
    });
  }, 60_000);
  // First pass waits for the renderer coordinator to subscribe (so no records
  // are lost), with a 30s ceiling so a renderer that never signals can't block
  // indexing forever.
  (async () => {
    await Promise.race([
      rendererReadyPromise,
      new Promise<void>((r) => {
        setTimeout(r, 30_000);
      }),
    ]);
    syncAll().catch(() => {
      /* swallowed */
    });
  })();
}

export function stopFileIndexLoop(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
