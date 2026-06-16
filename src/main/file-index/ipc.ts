/**
 * File-index IPC surface (main process). Renderer talks to the indexer through
 * these channels (mirrors agents-slack's qmdIpc.ts, de-qmd'd):
 *   - file-index:sources:{list,add,update,remove,presets,auto-register}
 *   - file-index:add-folder        (open a folder picker, register it)
 *   - file-index:sync / :sync-all  (kick a sync)
 *   - file-index:status            (sources + busy flags)
 *   - file-index:open-disk-access  (deep-link macOS Full Disk Access settings)
 * Main → renderer events (emitted from syncService): file-index:records,
 * file-index:deletions.
 */
import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import {
  AddSourceInput,
  addSource,
  autoRegisterPresets,
  knownPresetCandidates,
  listSources,
  removeSource,
  updateSource,
} from './sources';
import {
  cancelSource,
  purgeSource,
  startFileIndexLoop,
  markRendererReady,
  syncAll,
  syncSource,
} from './syncService';
import {
  seedDemoNotes,
  purgeDemoSourceIfPresent,
  type DemoSeedNote,
} from './seedDemo';
import { reconcileRxdbFromDocs } from './reconcile';
import { getGraphDoc } from '../file-graph/textStore';

let registered = false;

export function registerFileIndexHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('file-index:sources:list', () => listSources());

  // Storage-aware hydration fallback for local recall: the graph `docs`
  // SQLite (main process) holds every indexed file's full text, while the
  // renderer's RxDB row can exist with EMPTY content/fileText (older builds,
  // partial upserts — the reconcile only repairs rows missing ENTIRELY).
  // localSearch calls this for hits whose RxDB hydration came back text-less
  // so locally-indexed documents still reach the evidence with their body.
  ipcMain.handle(
    'file-index:get-doc-texts',
    async (_e, { ids }: { ids: string[] }) => {
      const docs: Record<
        string,
        { title: string; path: string; text: string }
      > = {};
      // Cap defensively — recall asks for a handful of misses, never bulk.
      for (const id of Array.isArray(ids) ? ids.slice(0, 60) : []) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const doc = await getGraphDoc(String(id));
          if (doc?.parentId) {
            docs[doc.parentId] = {
              title: doc.title || '',
              path: doc.path || '',
              text: doc.text || '',
            };
          }
        } catch {
          /* missing doc — skip */
        }
      }
      return { docs };
    },
  );

  ipcMain.handle(
    'file-index:sources:add',
    async (_e, input: AddSourceInput) => {
      const rec = await addSource(input);
      // Index immediately instead of waiting up to 60s for the next loop tick.
      if (rec.syncEnabled) syncSource(rec.id, { force: true }).catch(() => undefined);
      return rec;
    },
  );

  // Single-object payload: the renderer's invoke() forwards exactly one arg.
  ipcMain.handle(
    'file-index:sources:update',
    async (_e, { id, patch }: { id: string; patch: any }) => {
      if (patch?.syncEnabled === false) cancelSource(id);
      const nextPatch =
        patch?.syncEnabled === false
          ? { ...patch, inProgress: false, progress: undefined }
          : patch;
      return updateSource(id, nextPatch);
    },
  );

  // Remove the registry entry AND purge everything it indexed.
  ipcMain.handle('file-index:sources:remove', async (_e, id: string) => {
    await purgeSource(id);
    return removeSource(id);
  });

  ipcMain.handle('file-index:sources:presets', () => knownPresetCandidates());

  // Auto-register sensible defaults (Documents enabled; Downloads sync-disabled).
  // Obsidian is registered only after the user explicitly selects a vault.
  ipcMain.handle('file-index:sources:auto-register', () =>
    autoRegisterPresets(),
  );

  // Folder picker → register as a 'custom' source. Picking a folder grants the
  // app macOS read access to it via the powerbox (no Full Disk Access needed).
  ipcMain.handle('file-index:add-folder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const res = await dialog.showOpenDialog(win as any, {
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    const rec = await addSource({
      name: dir.split('/').filter(Boolean).pop() || dir,
      path: dir,
      kind: 'custom',
    });
    // Index immediately so the user sees progress right after picking.
    syncSource(rec.id, { force: true }).catch(() => undefined);
    return rec;
  });

  ipcMain.handle(
    'file-index:sync',
    (_e, { id, force }: { id: string; force?: boolean }) =>
      syncSource(id, { force }),
  );

  ipcMain.handle(
    'file-index:sync-all',
    (_e, opts?: { force?: boolean; includeDisabled?: boolean }) =>
      syncAll(opts ?? {}),
  );

  ipcMain.handle('file-index:cancel', (_e, id: string) => {
    cancelSource(id);
    return true;
  });

  ipcMain.handle('file-index:status', async () => {
    const sources = await listSources();
    return { sources };
  });

  // Deep-link the macOS Full Disk Access pane so the user can grant access to
  // TCC-protected folders (Documents/Downloads/Desktop) that the folder picker
  // didn't cover. No-op on non-macOS.
  ipcMain.handle('file-index:open-disk-access', () => {
    if (process.platform === 'darwin') {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      );
      return true;
    }
    return false;
  });

  // --- onboarding demo seed (no-data first-run auto-pilot) ---
  // Embed + insert a curated set of demo notes so Suggest/surface returns real
  // results during the first-run tour. Renderer passes the notes + source id.
  ipcMain.handle(
    'file-index:seed-demo',
    (_e, { sourceId, notes }: { sourceId: string; notes: DemoSeedNote[] }) =>
      seedDemoNotes(sourceId, notes ?? []),
  );

  // Explicit cleanup hook (also runs automatically on boot below).
  ipcMain.handle('file-index:purge-demo', async (_e, sourceId: string) => {
    await purgeDemoSourceIfPresent(sourceId);
    return true;
  });

  // Recover RxDB rows that diverged from the index (wipe/migration, or first
  // sync emitted before the renderer was listening). Re-emits notes from the
  // graph `docs` text store for parent ids the renderer reports it's missing.
  ipcMain.handle(
    'file-index:reconcile-rxdb',
    (_e, { haveIds }: { haveIds?: string[] }) =>
      reconcileRxdbFromDocs(haveIds ?? []),
  );

  // Renderer's coordinator is now subscribed to file-index:records — release
  // the first sync pass (see markRendererReady / startFileIndexLoop).
  ipcMain.handle('file-index:renderer-ready', () => {
    markRendererReady();
    return true;
  });

  // Boot-time cleanup: remove any demo notes a PRIOR session left behind. Runs
  // now (handlers register at startup) so it never deletes this session's demo
  // notes — those get seeded later and are purged on the next launch.
  purgeDemoSourceIfPresent('onboarding-demo-source').catch(() => undefined);

  // Start the periodic loop once handlers are live.
  startFileIndexLoop();
}
