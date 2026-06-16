/**
 * File-index source registry — JSON-backed list of indexed folders, owned by
 * the main process. Ported from agents-slack's ragSources.ts with the qmd
 * specifics removed: a "source" is one folder we index into the app's normal
 * RxDB + LanceDB stores (see syncService.ts), not a qmd collection.
 *
 * The renderer reads/writes sources via IPC (ipc.ts). The main process drives a
 * periodic sync loop that re-indexes each enabled source when it's dirty (a
 * file changed) or its interval has elapsed.
 */
import { app } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import {
  EXTRACTABLE_EXTENSIONS,
  INDEXABLE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from './extractors';

export type SourceKind = 'obsidian' | 'downloads' | 'documents' | 'custom';

export interface SyncProgress {
  scanned: number; // files completed or already unchanged in this pass
  embedded: number; // vectors embedded so far (diagnostic, not UI denominator)
  total: number; // total indexable files discovered in the source
  updatedAt: number;
}

export interface IndexedSource {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  /** Lower-case file extensions (with dot) this source indexes. */
  extensions: string[];
  /** Directory names to skip while walking (matched by basename). */
  ignoreDirs: string[];
  syncEnabled: boolean;
  syncIntervalMin: number;
  includeByDefault: boolean;
  lastSyncedAt?: number;
  lastDocCount?: number;
  lastError?: string;
  createdAt: number;
  // Resumable-sync state:
  inProgress?: boolean; // true while a sync is actively running
  lastSyncStartedAt?: number; // start time of the current/last sync attempt
  lastFullSyncAt?: number; // last time a sync ran to *completion*
  progress?: SyncProgress; // granular, persisted ~3s during run
}

// Constella's export feature writes timestamped vault snapshots into these
// dirs; indexing them would add huge near-duplicate sets, so skip everywhere a
// Documents-like tree is scanned (mirrors agents-slack's EXPORT_SNAPSHOT_IGNORES).
const EXPORT_SNAPSHOT_DIRS = [
  'Constella-Auto-Exports',
  'Constella-Manual-Export',
];

// Directory names skipped while walking any source tree. Dotdirs (.git, .next,
// .venv, …) are ALSO skipped by the dotfile guard in walkSource, but we list the
// common ones for clarity. The non-dot build/dependency dirs below are the ones
// that actually matter — they're how code repos (conch-ai, venvs) leaked in.
// Mirrors + extends agents-slack's qmd/NER ignore sets.
// Exported so the walk can ALWAYS apply this baseline, unioned with whatever a
// source persisted at creation time — otherwise existing sources keep their old
// (thin) ignore list forever and code-build dirs like `build/`/`venv/` leak in.
export const COMMON_IGNORE_DIRS = [
  // Constella's OWN asset store. Manual PDF/doc uploads + cloud-synced assets
  // are copied into `~/Documents/constella-assets/…`, and each ALREADY has its
  // own note (created by the upload / sync path). When a Documents source is
  // scanned it walks into this folder and re-indexes those files as local-file
  // notes — producing a DUPLICATE for every upload (one correct-title note +
  // one note titled with the asset's uniqueid filename). Skip it everywhere.
  'constella-assets',
  // VCS / editor / OS
  '.git',
  '.svn',
  '.hg',
  '.obsidian',
  '.trash',
  '.idea',
  '.vscode',
  // JS / web build + dependencies
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  // Python envs / caches
  'venv',
  '.venv',
  'site-packages',
  'dist-packages',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.eggs',
  // Rust / Go / Java / mobile build output
  'target',
  'vendor',
  'Pods',
  'DerivedData',
  '.gradle',
];

function defaultsForKind(
  kind: SourceKind,
): Pick<IndexedSource, 'extensions' | 'ignoreDirs' | 'includeByDefault'> {
  switch (kind) {
    case 'obsidian':
      // Full document set, not just markdown: vaults commonly hold PDF/Word
      // attachments that notes `[[link]]` to — they need to be indexed for
      // those links to resolve (and to be searchable at all).
      return {
        extensions: [...INDEXABLE_EXTENSIONS],
        ignoreDirs: [...COMMON_IGNORE_DIRS],
        includeByDefault: true,
      };
    case 'downloads':
    case 'documents':
      return {
        extensions: [...INDEXABLE_EXTENSIONS],
        ignoreDirs: [...COMMON_IGNORE_DIRS, 'Library', ...EXPORT_SNAPSHOT_DIRS],
        // Documents/Downloads are noisy — off the default search set; the user
        // opts a source in explicitly.
        includeByDefault: false,
      };
    case 'custom':
    default:
      return {
        extensions: [...INDEXABLE_EXTENSIONS],
        ignoreDirs: [...COMMON_IGNORE_DIRS, ...EXPORT_SNAPSHOT_DIRS],
        includeByDefault: true,
      };
  }
}

/** Extensions a source contributes to the index — used by the sync loop's
 *  change-probe so it reacts only to files we'd index, not sidecar churn. */
export function indexableExtensions(source: IndexedSource): string[] {
  return source.extensions?.length ? source.extensions : INDEXABLE_EXTENSIONS;
}

/** True for the binary types that need extraction (vs. plain text read). */
export function isExtractable(ext: string): boolean {
  return EXTRACTABLE_EXTENSIONS.includes(ext.toLowerCase());
}

function registryPath(): string {
  return path.join(app.getPath('userData'), 'file-index-sources.json');
}

let cache: IndexedSource[] | null = null;
let writeChain: Promise<void> = Promise.resolve();
let watcher: fsSync.FSWatcher | null = null;
let lastWriteSelf = 0; // marker so our own writes don't trigger reload
let allowShrink = false; // set only by removeSource

// Collapse registry rows that point at the same folder (same resolved path).
// A prior bug minted a fresh id for every preset re-register (autoRegisterPresets
// / add-folder omit `id`, so the id-based dedup never matched), letting
// preset folders pile up many times. Keep the first row but prefer an enabled
// copy if the original was disabled.
function dedupeByPath(list: IndexedSource[]): IndexedSource[] {
  const seen = new Map<string, IndexedSource>();
  for (const s of list) {
    const key = path.resolve(s.path);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, s);
    } else if (s.syncEnabled && !prev.syncEnabled) {
      // keep the original id/createdAt, adopt the enabled state
      seen.set(key, { ...prev, syncEnabled: true });
    }
  }
  return Array.from(seen.values());
}

// Obsidian vaults registered before attachments were supported persisted the
// old text-only default extension list. Upgrade exactly that list to the full
// indexable set so vault PDFs/docs start indexing (and `[[Paper.pdf]]` links
// can resolve); any other list is treated as user-customized and left alone.
function upgradeObsidianExtensions(s: IndexedSource): IndexedSource {
  if (s.kind !== 'obsidian') return s;
  const oldDefault = new Set(TEXT_EXTENSIONS);
  const current = (s.extensions ?? []).map((e) => e.toLowerCase());
  const isOldDefault =
    current.length === oldDefault.size &&
    current.every((e) => oldDefault.has(e));
  if (!isOldDefault) return s;
  return { ...s, extensions: [...INDEXABLE_EXTENSIONS] };
}

async function readFromDisk(): Promise<IndexedSource[]> {
  try {
    const raw = await fs.readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed
      .filter(
        (s: any) => s && typeof s.id === 'string' && typeof s.path === 'string',
      )
      .map(upgradeObsidianExtensions);
    // Dedupe on read so both the cache and the writeToDisk shrink-guard see a
    // consistent (collapsed) view — otherwise the guard would merge the dupes
    // straight back in.
    return dedupeByPath(valid);
  } catch (e: any) {
    return [];
  }
}

async function writeToDisk(sources: IndexedSource[]): Promise<void> {
  // SAFETY GUARD: never silently overwrite disk with a shorter list unless a
  // removeSource() set allowShrink — merge back any entries only on disk.
  try {
    const onDisk = await readFromDisk();
    if (onDisk.length > 0 && sources.length < onDisk.length && !allowShrink) {
      const haveIds = new Set(sources.map((s) => s.id));
      const merged = [...sources, ...onDisk.filter((s) => !haveIds.has(s.id))];
      cache = merged;
      sources = merged;
      // eslint-disable-next-line no-console
      console.warn(
        `[file-index] guard merged ${
          onDisk.length - haveIds.size
        } sources from disk missing in cache`,
      );
    }
  } catch {
    /* fall through and write what we have */
  }
  const tmp = `${registryPath()}.tmp`;
  await fs.mkdir(path.dirname(registryPath()), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(sources, null, 2), 'utf8');
  lastWriteSelf = Date.now();
  await fs.rename(tmp, registryPath());
}

/** Reload the cache from disk on the next call. */
export function invalidateCache(): void {
  cache = null;
}

function ensureWatcher(): void {
  if (watcher) return;
  try {
    fsSync.mkdirSync(path.dirname(registryPath()), { recursive: true });
    watcher = fsSync.watch(path.dirname(registryPath()), (_event, filename) => {
      if (filename !== 'file-index-sources.json') return;
      if (Date.now() - lastWriteSelf < 2000) return; // ignore our own writes
      cache = null;
    });
    watcher.on('error', () => {
      watcher = null;
    });
  } catch {
    /* watch unavailable — non-fatal */
  }
}

function persist(): void {
  writeChain = writeChain.then(() => writeToDisk(cache ?? []));
}

let flushedDupeCleanup = false;

export async function loadSources(): Promise<IndexedSource[]> {
  ensureWatcher();
  if (cache) return cache;
  cache = await readFromDisk();
  // One-time flush so the de-duplicated list is written back and the registry
  // file stops carrying historical duplicate rows. Safe: readFromDisk already
  // dedupes, so the shrink-guard's on-disk read matches the cache length.
  if (!flushedDupeCleanup) {
    flushedDupeCleanup = true;
    persist();
  }
  return cache;
}

export function listSourcesSync(): IndexedSource[] {
  return cache ?? [];
}

export async function listSources(): Promise<IndexedSource[]> {
  return loadSources();
}

export async function getSource(
  id: string,
): Promise<IndexedSource | undefined> {
  return (await loadSources()).find((s) => s.id === id);
}

export interface AddSourceInput {
  id?: string;
  name: string;
  path: string;
  kind: SourceKind;
  extensions?: string[];
  ignoreDirs?: string[];
  syncEnabled?: boolean;
  syncIntervalMin?: number;
  includeByDefault?: boolean;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'src'
  );
}

function uniqueId(all: IndexedSource[], base: string): string {
  let candidate = base;
  let n = 2;
  while (all.some((s) => s.id === candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export async function addSource(input: AddSourceInput): Promise<IndexedSource> {
  const all = await loadSources();
  const defaults = defaultsForKind(input.kind);
  const resolvedPath = path.resolve(input.path);
  // Idempotent by folder: never index the same path twice. Callers like
  // autoRegisterPresets / add-folder omit `id`, so the old id-based check minted
  // a fresh unique id each call and piled up duplicate preset rows.
  const samePath = all.find((s) => path.resolve(s.path) === resolvedPath);
  if (samePath) return samePath;
  const id = input.id ?? uniqueId(all, slugify(input.name));
  const existing = all.find((s) => s.id === id);
  if (existing) return existing; // idempotent — re-adding a preset is a no-op
  const rec: IndexedSource = {
    id,
    name: input.name,
    path: resolvedPath,
    kind: input.kind,
    extensions: input.extensions ?? defaults.extensions,
    ignoreDirs: input.ignoreDirs ?? defaults.ignoreDirs,
    syncEnabled: input.syncEnabled ?? true,
    syncIntervalMin: input.syncIntervalMin ?? 10,
    includeByDefault: input.includeByDefault ?? defaults.includeByDefault,
    createdAt: Date.now(),
  };
  all.push(rec);
  cache = all;
  persist();
  return rec;
}

export async function updateSource(
  id: string,
  patch: Partial<IndexedSource>,
): Promise<IndexedSource | undefined> {
  const all = await loadSources();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return undefined;
  const merged = {
    ...all[idx],
    ...patch,
    id: all[idx].id,
    createdAt: all[idx].createdAt,
  };
  all[idx] = merged;
  cache = all;
  persist();
  return merged;
}

// In-memory progress patch + debounced disk flush (coalesce embed-tick spam).
const progressFlushers = new Map<string, ReturnType<typeof setTimeout>>();
const PROGRESS_FLUSH_MS = 3000;

export function updateSourceProgress(
  id: string,
  patch: Partial<SyncProgress> & { inProgress?: boolean; lastError?: string },
): void {
  const all = cache;
  if (!all) return;
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const cur = all[idx];
  const { inProgress, lastError, ...progFields } = patch;
  const nextProgress: SyncProgress | undefined =
    Object.keys(progFields).length > 0
      ? {
          scanned: 0,
          embedded: 0,
          total: 0,
          ...(cur.progress ?? {}),
          ...progFields,
          updatedAt: Date.now(),
        }
      : cur.progress;
  all[idx] = {
    ...cur,
    ...(inProgress !== undefined ? { inProgress } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    progress: nextProgress,
  };
  const existing = progressFlushers.get(id);
  if (existing) clearTimeout(existing);
  progressFlushers.set(
    id,
    setTimeout(() => {
      progressFlushers.delete(id);
      persist();
    }, PROGRESS_FLUSH_MS),
  );
}

/** Force-flush pending progress writes (call on app quit). */
export function flushPendingProgress(): void {
  let any = false;
  for (const [, t] of progressFlushers) {
    clearTimeout(t);
    any = true;
  }
  progressFlushers.clear();
  if (any) persist();
}

export async function removeSource(id: string): Promise<boolean> {
  const all = await loadSources();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  cache = all;
  allowShrink = true; // intentional shrinkage — let the guard through
  persist();
  writeChain = writeChain.then(() => {
    allowShrink = false;
  });
  return true;
}

function legacyObsidianPresetPaths(): string[] {
  const home = app.getPath('home');
  return [
    path.join(home, 'Documents', 'Obsidian'),
    path.join(home, 'Obsidian'),
    path.join(
      home,
      'Library',
      'Mobile Documents',
      'iCloud~md~obsidian',
      'Documents',
    ),
  ].map((candidate) => path.resolve(candidate));
}

// Removes Obsidian sources created by the old best-guess preset registration.
async function removeLegacyObsidianPresetSources(): Promise<void> {
  const legacyPaths = new Set(legacyObsidianPresetPaths());
  const sources = await loadSources();
  const legacySources = sources.filter(
    (source) =>
      source.kind === 'obsidian' &&
      source.name === 'Obsidian' &&
      legacyPaths.has(path.resolve(source.path)),
  );

  for (const source of legacySources) {
    await removeSource(source.id);
  }
}

/** Suggested preset folders for auto-register (best-effort on macOS). */
export function knownPresetCandidates(): Array<{
  kind: SourceKind;
  name: string;
  path: string;
}> {
  const candidates: Array<{ kind: SourceKind; name: string; path: string }> = [
    { kind: 'documents', name: 'Documents', path: app.getPath('documents') },
    { kind: 'downloads', name: 'Downloads', path: app.getPath('downloads') },
  ];
  return candidates.filter((c) => c.path && fsSync.existsSync(c.path));
}

/** Register the preset folders into the index (idempotent — addSource no-ops
 *  an existing id). Documents syncs by default; Downloads is registered
 *  sync-disabled because it is too noisy until the user opts in. Obsidian is
 *  registered only after the user explicitly picks a vault. */
export async function autoRegisterPresets(): Promise<IndexedSource[]> {
  await removeLegacyObsidianPresetSources();
  const added: IndexedSource[] = [];
  for (const p of knownPresetCandidates()) {
    const rec = await addSource({
      name: p.name,
      path: p.path,
      kind: p.kind,
      syncEnabled: p.kind !== 'downloads',
    });
    added.push(rec);
  }
  return added;
}
