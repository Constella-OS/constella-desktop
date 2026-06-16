/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  globalShortcut,
  screen,
  session,
  Notification,
  protocol,
  net,
  systemPreferences,
  nativeImage,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import MenuBuilder from './menu';
import { applyAppleMetalWorkaroundEnv } from './appleMetalGuardrails';

// Apply Apple-Silicon Metal guardrails BEFORE node-llama-cpp ever loads its
// native binary (every getLlama() in this app is lazy, so doing it here — the
// top of the main module — is in time for the local LLM + embedding model in
// this process, and the worker inherits these via process.env at fork). Without
// this, libggml crashes on M5+ machines when a model/context is created.
{
  const applied = applyAppleMetalWorkaroundEnv();
  if (applied.length) {
    // electron-log isn't loaded yet at this point; console is fine.
    // eslint-disable-next-line no-console
    console.log('[metal-guardrails] applied:', applied.join(' '));
  }
}

const { Worker } = require('worker_threads');
import { machineIdSync } from 'node-machine-id';
import { resolveHtmlPath } from './util';
import * as Sentry from '@sentry/electron/main';
import installExtension, {
  REACT_DEVELOPER_TOOLS,
} from 'electron-devtools-installer';
import {
  createEmbedding,
  embedQuery,
  createEmbeddingFromBackend,
} from './ai/create-embedding';
import { exportNotes, importNotes } from './utils/settings';
import {
  readObsidianFiles,
  readObsidianVaultDirectory,
} from './utils/obsidian-vault';
import { listLocalFolderFiles } from './utils/local-files';
import os from 'os';
import {
  clearPendingAuthDeepLink,
  getPendingAuthDeepLink,
  setupDeepLinks,
} from './utils/deep-linking';
import { setupStorageHandlers } from './utils/storage/storage-handlers';
import {
  createImageEmbedding,
  imageToTextWithFileProcessing,
} from './ai/image-to-text';
import { setupClipboardHandlers } from './utils/clipboard/clipboard-handlers';
import { getLocalFilePath } from './utils/storage/storage';
import { LOCAL_FILE_PROTOCOL, STORE_KEYS, hasRealKey } from './constants';
import { setupFileEmbeddingHandlers } from './ai/file-embedding-handler';
import { setupMiscHandlers } from './utils/misc/misc-handlers';
import { setupLLMHandlers } from './ai/llm-handlers';
import {
  clearStore,
  getStoreValue,
  setStoreValue,
} from './utils/storage/store';
import { getImageToTextPipeline } from './ai/transformers';
import { getEmbeddingService } from './ai/embedding/embedding-service';
import { setupVectorDBHandlers } from './utils/vector-db/handlers';
import {
  registerProviderHandlers,
  startProviders,
  stopProviders,
} from './providers/runner';
import { registerFileIndexHandlers } from './file-index/ipc';
import { registerMainDbHandlers } from './main-db/ipc';
import { closeMainDb, deleteMainDb } from './main-db/db';
import { registerAgentSystemIpc } from './agents/agentSystemIpc';
import {
  addSource as addFileIndexSource,
  flushPendingProgress as flushFileIndexProgress,
} from './file-index/sources';
import {
  stopFileIndexLoop,
  syncSource as syncFileIndexSource,
} from './file-index/syncService';
import { runFileIndexStartup } from './file-index/startup';
import { registerFileGraphHandlers } from './file-graph/ipc';
import { stopGraphScheduler } from './file-graph/scheduler';
import {
  initEngineFileLog,
  installCrashMonitoring,
  registerDiagnosticsIpc,
  scheduleBootDiagnostics,
} from './diagnostics/indexingDiagnostics';
import {
  startAppMcpServer,
  stopAppMcpServer,
  getMcpConnectionInfo,
} from './mcp';
import { registerMcpBridge } from './mcp/bridge';
import {
  createSearchOverlayWindow,
  showSearchOverlay,
  hideSearchOverlay,
  isSearchOverlayVisible,
  getSearchOverlayWindow,
  setSearchOverlayHeight,
} from './searchOverlayWindow';

const isMac = os.platform().includes('darwin');
const isWindows = os.platform().includes('win32');

// Swallow EIO/EPIPE on stdio so a closed parent pipe (packaged app, no terminal)
// doesn't surface as a fatal error via Sentry's console breadcrumb capture.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e: NodeJS.ErrnoException) => {
    if (e?.code !== 'EIO' && e?.code !== 'EPIPE') throw e;
  });
}

const log = require('electron-log');
// log.transports.file.level = 'info';
// log.transports.file.file = __dirname + 'log.log';

// Persist all console.* output to <userData>/logs/engine-<date>.log. Packaged
// builds have no terminal, so the file-index / file-graph engines' console logs
// would otherwise be lost — this tees them to disk so we can inspect indexing
// after a production build. Idempotent + defensive; never throws.
initEngineFileLog();
// Last-resort crash/error nets: Crashpad minidumps + render-process-gone +
// child-process-gone + uncaughtException/unhandledRejection, all routed to the
// engine log. This is what captures the "double-click PDF → app shuts down"
// renderer crash and any native indexing abort — neither of which console
// logging can see on its own.
installCrashMonitoring();

try {
  Sentry.init({
    dsn: process.env.SENTRY_DSN || '',
  });
} catch (error) {
  console.error('Error initializing Sentry:', error);
}

class AppUpdater {
  constructor() {
    const log = require('electron-log');
    log.transports.file.level = 'debug';
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    // for manual updating, can set autoUpdater.autoDownload = false and then call .update()
    // Do not check initially to let user use the
    // app and not get annoyed if they need to jot something down
    // autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    //   log.error(err);
    // });
  }
}

export let mainWindow: BrowserWindow | null = null;
let delayedCloseAlready = false;
// let searchWindow: BrowserWindow | null = null;
// If true, the overlay was explicitly shown via the overlay shortcut and should
// persist across app switching until the user toggles it off.
let isSearchOverlayPinned = false;
// True for a short window after we trigger `showSearchOverlay()`. macOS will
// un-hide the app (since `app.hide()` was called when the overlay was last
// dismissed) and surface the main window. We use this flag in
// `mainWindow.on('show')` to differentiate the un-hide from a real user-driven
// surface so we can re-hide the main window instead of hiding the overlay.
let suppressNextMainSurface = false;

// Register protocol for deep linking
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('constella-app-desktop', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('constella-app-desktop');
}

/**** IPC HANDLERS *****/

// auth: mint access token from main process (bypasses CORS)
// Opens a URL in the user's default browser. Renderer-side plumbing lives in
// preload.ts (window.electron.openExternal) → ElectronPlatformAdapter.shell.openExternal.
ipcMain.on('open-external', (_event, url: string) => {
  if (typeof url === 'string' && url.length > 0) {
    void shell.openExternal(url);
  }
});

// Opens a LOCAL FILE PATH in the OS default app (e.g. a .docx in Word/Pages,
// or revealing it in Finder). Distinct from 'open-external' above, which is for
// http(s) URLs. Renderer plumbing: preload.ts (window.electron.open) — used by
// concept-page source rows in ConceptPageModal and other "open the underlying
// file" affordances. This handler previously lived only inside
// createSearchWindow() (searchWindow.ts), which is no longer mounted, so the
// IPC went unhandled and clicks silently did nothing.
ipcMain.on('open', (_event, filePath: string) => {
  if (typeof filePath === 'string' && filePath.length > 0) {
    void shell.openPath(filePath);
  }
});

// Persists the onboarding user-context (role + persona) mirrored from the
// renderer so the local AI prompt builders (providers/runner, file-graph/llm)
// can prepend a "who the user is" preamble. Updates the in-memory cache + store.
ipcMain.handle('user-context:set', async (_event, args) => {
  try {
    const { setUserContext } = require('./userContext');
    setUserContext({
      workTypeLabel: args?.workTypeLabel,
      persona: args?.persona,
    });
    return { success: true };
  } catch (e: any) {
    log.error('Error setting user context', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

// Shows a system notification from the main process (works even when the
// window is backgrounded). Clicking it brings the app back to front. Used by
// onboarding to announce that the first indexing pass finished.
ipcMain.handle('app:notify', async (_event, args) => {
  try {
    const title = typeof args?.title === 'string' ? args.title : 'Constella';
    const body = typeof args?.body === 'string' ? args.body : '';
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notification.show();
    return { success: true };
  } catch (e: any) {
    log.error('Error showing app:notify notification', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('mint-access-token', async (_event, args) => {
  const axios = require('axios').default;
  const { BACKEND_URL } = require('./constants');
  const { tenantName, userEmail, firebaseIdToken } = args;

  console.log('[Auth:Main] Minting access token for:', tenantName, userEmail);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (firebaseIdToken) {
    headers['firebase-id-token'] = firebaseIdToken;
    console.log(
      '[Auth:Main] Including firebase-id-token (length:',
      firebaseIdToken.length,
      ')',
    );
  }

  try {
    const response = await axios.post(
      `${BACKEND_URL}auth/get-access-token`,
      { tenant_name: tenantName, user_email: userEmail },
      { headers },
    );

    const token = response.data?.token || '';
    console.log(
      '[Auth:Main] Mint response status:',
      response.status,
      '| has token:',
      !!token,
    );

    if (token) {
      axios.defaults.headers.common['access-token'] = token;
      console.log(
        '[Auth:Main] Access token SET on main process axios defaults (length:',
        token.length,
        ')',
      );
      // Remember the tenant + kick the integration relay so cloud records
      // start mirroring into the local index right after sign-in.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        require('./integration-relay/relayService').setRelayTenant(tenantName);
      } catch {
        /* relay optional */
      }
    }

    return { success: true, token };
  } catch (error: any) {
    console.error('[Auth:Main] Mint failed:', error.message);
    return { success: false, error: error.message };
  }
});

// auth: receive access token from renderer and set on axios defaults
ipcMain.handle('set-access-token', async (_event, args) => {
  const axios = require('axios').default;
  if (args.token) {
    axios.defaults.headers.common['access-token'] = args.token;
    console.log(
      '[Auth:Main] Access token SET on main process axios defaults (token length:',
      args.token.length,
      ')',
    );
  } else {
    delete axios.defaults.headers.common['access-token'];
    console.log(
      '[Auth:Main] Access token CLEARED from main process axios defaults',
    );
  }
});

// auth: lets renderer flows replay a browser callback that landed before their modal listener mounted
ipcMain.handle('get-pending-auth-deep-link', async () => {
  return getPendingAuthDeepLink();
});

// auth: clears the cached browser callback after one renderer flow has consumed it
ipcMain.handle('clear-pending-auth-deep-link', async () => {
  clearPendingAuthDeepLink();
  return true;
});

// vectorization
ipcMain.handle('embed-text', async (event, args) => {
  const axios = require('axios').default;
  const hasToken = !!axios.defaults.headers.common['access-token'];
  console.log(
    '[Embed:Main] embed-text called. text:',
    JSON.stringify(args.text).slice(0, 80),
    '| main process has access-token:',
    hasToken,
  );
  try {
    // EmbeddingGemma needs the right task template: 'query' for searches,
    // 'document' for stored text. Default to document for back-compat.
    const embedding =
      args.kind === 'query'
        ? await embedQuery(args.text)
        : await createEmbedding(args.text);

    if (!embedding || embedding.length === 0) {
      if (!hasToken) {
        console.log(
          '[Embed:Main] Local embedding failed and no access token — skipping backend fallback',
        );
        return null;
      }
      console.log(
        '[Embed:Main] Local embedding failed/empty, falling back to backend',
      );
      return createEmbeddingFromBackend(args.text);
    }
    return embedding;
  } catch (error) {
    console.error('[Embed:Main] Error embedding text:', error);
    return null;
  }
});

// Previously spawned a separate transformers.js (MiniLM) worker thread. Text now
// embeds on the single shared node-llama-cpp runtime (EmbeddingGemma), whose heavy
// compute already runs off the JS thread, so we just delegate to the same path —
// no second embedding stack. Still routes by 'query' vs 'document' task template.
ipcMain.handle('embed-text-worker', async (event, args) => {
  try {
    return args.kind === 'query'
      ? await embedQuery(args.text)
      : await createEmbedding(args.text);
  } catch (error) {
    console.error('Error embedding text (worker handler):', error);
    return null;
  }
});

ipcMain.handle('embed-image', async (event, args) => {
  const res = await createImageEmbedding(args.imagePath);
  return { imageText: res?.imageText ?? '', embedding: res?.embedding ?? [] };
});

ipcMain.handle('embed-image-worker', async (event, args) => {
  try {
    let imagePath = getLocalFilePath(args.imagePath, false);

    const worker = new Worker(
      './src/main/ai/workers/image-embedding-worker.js',
      {
        workerData: { imagePath },
      },
    );

    // Worker returns the caption text; embed it here on the shared EmbeddingGemma
    // runtime so the vector matches every other note (512-dim), then return the
    // same { imageText, embedding } shape as the non-worker embed-image handler.
    return new Promise((resolve, reject) => {
      worker.on('message', async (result: any) => {
        try {
          const imageText = result?.imageText ?? '';
          const embedding = (await createEmbedding(imageText)) ?? [];
          resolve({ imageText, embedding });
        } catch (err) {
          reject(err);
        }
      });
      worker.on('error', (error: any) => {
        console.log('Error in worker');
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error creating worker:', error);
    throw error;
  }
});

ipcMain.handle('image-to-text', async (event, args) => {
  try {
    let imageText = await imageToTextWithFileProcessing(args.imagePath);
    return imageText;
  } catch (error) {
    console.error('Error creating worker:', error);
    throw error;
  }
});

ipcMain.handle('image-to-text-worker', async (event, args) => {
  try {
    let imagePath = getLocalFilePath(args.imagePath, false);

    const worker = new Worker('./src/main/ai/workers/image-to-text-worker.js', {
      workerData: { imagePath: imagePath },
    });

    return new Promise((resolve, reject) => {
      worker.on('message', (result: any) => {
        resolve(result);
      });
      worker.on('error', (error: any) => {
        console.log('Error in worker');
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error creating worker:', error);
    throw error;
  }
});

// settings

ipcMain.handle('request-microphone-permission', async () => {
  try {
    // Check if we're on macOS
    if (process.platform === 'darwin') {
      // First check current status
      const currentStatus =
        systemPreferences.getMediaAccessStatus('microphone');

      if (currentStatus === 'granted') {
        return true;
      } else if (currentStatus === 'denied') {
        return false;
      }

      // Request permission if not determined
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return granted;
    } else {
      // For other platforms, assume permission is granted
      // You might want to implement Windows-specific logic here
      return true;
    }
  } catch (error) {
    console.error('Error requesting microphone permission:', error);
    return false;
  }
});

ipcMain.handle('export-notes', async (event, args) => {
  const result = await exportNotes(
    args.notes,
    args.notesbyId,
    args.dailyNotes,
    args?.autoExport ?? false,
  );
  return result;
});

ipcMain.handle('import-notes', async (event, arg) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  const parsedNotes = await importNotes(result.filePaths[0]);
  return parsedNotes;
});

ipcMain.handle('select-obsidian-vault-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      notes: [],
      selectedPath: null,
    };
  }

  const selectedPath = result.filePaths[0];
  const notes = await readObsidianVaultDirectory(selectedPath);

  // Register the picked vault as a locally-indexed source so its files get
  // semantic indexing + `[[ ]]` backlinking (idempotent). Picking the folder
  // grants macOS read access via the powerbox, so this works even without Full
  // Disk Access. Force an immediate sync so the vault indexes right away instead
  // of waiting up to 60s for the next file-index loop tick.
  addFileIndexSource({
    name: path.basename(selectedPath) || 'Obsidian',
    path: selectedPath,
    kind: 'obsidian',
  })
    .then((rec) => {
      syncFileIndexSource(rec.id, { force: true }).catch(() => undefined);
    })
    .catch(() => {
      /* non-fatal — indexing registration shouldn't block the import */
    });

  return {
    notes,
    selectedPath,
  };
});

ipcMain.handle('select-obsidian-vault-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Obsidian Notes',
        extensions: ['md', 'txt'],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      notes: [],
      selectedPath: null,
    };
  }

  const notes = await readObsidianFiles(result.filePaths);

  return {
    notes,
    selectedPath: result.filePaths[0],
  };
});

// Generic local-import pickers backing the "Folders" and "Files" integration
// tiles. They return only the user-selected paths (no read/parse work) so the
// renderer can hand them to whatever ingest path is wired up next.
ipcMain.handle('pick-local-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { folderPath: null };
  }

  return { folderPath: result.filePaths[0] };
});

ipcMain.handle('pick-local-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Documents',
        extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'rtf'],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { filePaths: [] };
  }

  return { filePaths: result.filePaths };
});

// Recursively enumerates every supported file under the given folder path —
// docs (pdf/doc/docx/txt/md), images, and note text files. Used by the
// "Folders" local-import tile to fan out a directory into an upload queue.
ipcMain.handle('list-local-folder-files', async (_event, args) => {
  const folderPath: string | undefined = args?.folderPath;
  if (!folderPath || typeof folderPath !== 'string') {
    return { filePaths: [] };
  }
  try {
    const filePaths = await listLocalFolderFiles(folderPath);
    return { filePaths };
  } catch (error) {
    console.error('list-local-folder-files failed:', error);
    return { filePaths: [] };
  }
});

ipcMain.handle('reset-app', async (event, arg) => {
  if (mainWindow) await clearAppCache(mainWindow);
  // The sqlite main DB lives outside session storage — delete it explicitly
  // (also clears the rxdb->sqlite migration flag, which lives in the same
  // file, so a reset re-onboards cleanly).
  await deleteMainDb();
  return true;
});

// TODO: for now just closing since reloading causes RXDB error
ipcMain.handle('relaunch-app', async () => {
  mainWindow?.close();
  app.quit();
});

ipcMain.handle('get-platform', async () => {
  let deviceId = '';
  try {
    deviceId = 'device-' + machineIdSync();
  } catch (error) {}
  return {
    isMac,
    isWindows,
    deviceId,
  };
});
// Lets a renderer learn its own webContents id — used by the main-db client
// to ignore its own db:changed echoes.
ipcMain.handle('get-web-contents-id', (event) => event.sender.id);

// Cross-device identity: every backend request from main (integration relay,
// token mint, ...) carries this device's id so the backend can stamp records
// with lastUpdateDeviceId and relay_pull can exclude our own writes — that's
// what lets other devices' notes flow down without echoing ours back.
try {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const axiosMain = require('axios').default;
  axiosMain.defaults.headers.common['device-id'] = `device-${machineIdSync()}`;
} catch (e) {
  console.warn('[device-id] failed to set main axios header:', e);
}
ipcMain.handle('get-device-id', async () => {
  let deviceId = '';
  try {
    deviceId = 'device-' + machineIdSync();
  } catch (error) {}
  return deviceId;
});
ipcMain.handle('close-window', async () => {
  mainWindow?.close();
});
ipcMain.handle('minimize-window', async () => {
  mainWindow?.minimize();
});
ipcMain.handle('restore-main-window', async () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    isSearchOverlayPinned = false;
    hideSearchOverlay();
  }
});
ipcMain.handle('hide-search-overlay', async () => {
  isSearchOverlayPinned = false;
  hideSearchOverlay();
  // On macOS, hiding the overlay can leave Constella as the active app,
  // which may cause the main window to come to the front. Hide the app to
  // return focus to the previously active application.
  if (isMac) {
    app.hide();
  }
});
// Quick-capture: overlay renderer hands us the typed text. Forward it to the
// main renderer so `HomeUI.triggerAddNote` runs the exact same pipeline as the
// main search bar's Enter (tag parsing, RxDB insert, Weaviate sync with the
// axios access-token interceptor). No main-window surfacing — the note is
// saved silently in the background renderer.
ipcMain.handle('overlay-capture-note', async (_evt, args: { text?: string }) => {
  const text = args?.text;
  if (!mainWindow || typeof text !== 'string' || !text.trim()) return;
  mainWindow.webContents.send('overlay-create-note', { text });
});

// Overlay → main process → main renderer. Main renderer owns the user's
// auth token + tags store, so it runs the cloud search and sends results
// back via `overlay-search-results-internal`, which we forward to the
// overlay window below.
ipcMain.handle(
  'overlay-search',
  async (
    _evt,
    args: { requestId: string; query: string; tagNames: string[] },
  ) => {
    if (!mainWindow) return;
    mainWindow.webContents.send('overlay-search-request', args);
  },
);

ipcMain.handle('overlay-search-results-internal', async (_evt, payload) => {
  const overlay = getSearchOverlayWindow();
  if (!overlay) return;
  overlay.webContents.send('overlay-search-results', payload);
});

// Main renderer pushes a serialized snapshot of `useTagsStore` whenever it
// changes (and on overlay request). Forwarded straight to the overlay
// renderer, which keeps a local copy for the `#` picker.
ipcMain.handle('overlay-tags-snapshot-internal', async (_evt, payload) => {
  const overlay = getSearchOverlayWindow();
  if (!overlay) return;
  overlay.webContents.send('overlay-tags-snapshot', payload);
});

// Overlay asks the main renderer to push the latest tags. Used when the
// overlay window mounts (it boots empty in its own renderer process).
ipcMain.handle('overlay-request-tags', async () => {
  if (!mainWindow) return;
  mainWindow.webContents.send('overlay-tags-request', {});
});

// Overlay → main: user clicked a search result. Surface the main window
// and forward the note id so HomeUI can navigate/open it.
ipcMain.handle(
  'overlay-open-note',
  async (_evt, args: { uniqueid?: string }) => {
    const uniqueid = args?.uniqueid;
    if (!mainWindow || !uniqueid) return;
    isSearchOverlayPinned = false;
    hideSearchOverlay();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('overlay-open-note', { uniqueid });
  },
);

// Overlay tells us how tall it wants to be (input + tag picker + results
// add up dynamically). Clamped at the min/max in setSearchOverlayHeight.
ipcMain.handle(
  'overlay-set-height',
  async (_evt, args: { height?: number }) => {
    const height = Number(args?.height);
    if (!Number.isFinite(height)) return;
    const clamped = Math.min(Math.max(Math.round(height), 120), 800);
    setSearchOverlayHeight(clamped);
  },
);
/**
 * Returns true if the window is maximized, false if it is not
 */
ipcMain.handle('toggle-maximize-window', async () => {
  try {
    if (mainWindow?.isMaximized()) {
      mainWindow?.unmaximize();
      return false;
    } else {
      mainWindow?.maximize();
      return true;
    }
  } catch (error) {
    console.error('Error toggling maximize window:', error);
    return false;
  }
});
/**
 * Check for updates
 */
ipcMain.handle('check-for-updates', async () => {
  console.log('CHECKING FOR UPDATES!!');
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.error(err);
  });
});
ipcMain.handle('replace-misspelling', (ev, value) => {
  mainWindow?.webContents.replaceMisspelling(value);
});

setupVectorDBHandlers();
setupStorageHandlers();
setupClipboardHandlers();
setupFileEmbeddingHandlers();
setupMiscHandlers();
setupLLMHandlers();
// Provider abstraction: local (utilityProcess) + claude-cli IPC handlers.
registerProviderHandlers();
// Agents feature: native folder picker + per-agent fs read/write for the
// Memories browser (fs:*, dialog:pick-folder, shell:open-path).
registerAgentSystemIpc();
// Local file indexing: source registry + folder sync loop (writes LanceDB
// directly, streams records to the renderer for RxDB).
registerFileIndexHandlers();
// Main DB (node:sqlite in a worker_thread): the relational store for notes/
// tags/chats/misc — renderer reaches it via the generic 'db:call' channel.
registerMainDbHandlers();
// Local knowledge-graph engine: clusters indexed docs → concept pages → themes,
// streamed to the renderer's Discoveries graph. Background, recall-gated.
registerFileGraphHandlers();
// Indexing diagnostics: IPC `file-index:diagnostics` to dump the pipeline state
// on demand, plus one auto-snapshot ~60s after boot so every production launch
// leaves a queryable report at <userData>/diagnostics/indexing-report.md.
registerDiagnosticsIpc();
scheduleBootDiagnostics();
// Integration relay: pulls cloud-stored integration records (Notion, Gmail,
// Zotero via backend) down into the LOCAL index (SQLite + LanceDB + graph
// engine) on a persisted cursor — the desktop is the single knowledge store.
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
require('./integration-relay/relayService').startIntegrationRelayLoop();
// MCP "brain" bridge: lets the in-app MCP server's search/get-note tools
// round-trip to the main renderer (which owns auth + the real search + RxDB).
registerMcpBridge(() => mainWindow);

// Surface the LOCAL MCP server's live connection details to the renderer so the
// UI can show a copy-paste "connect your own Claude Code / Codex" command that
// points at this device's server (not the cloud fastfind.app endpoint). Returns
// null until the server has bound. Localhost-only + user-owned, so handing the
// renderer the bearer is fine — the user needs it to wire their terminal.
ipcMain.handle('mcp:get-local-connection', () => {
  const conn = getMcpConnectionInfo();
  if (!conn) return null;
  return { url: conn.url, port: conn.port, secret: conn.secret };
});

/***** END IPC HANDLERS *****/

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

/**
 * Handle debug mode
 */
const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';
if (isDebug) {
  // require('electron-debug')();
}

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');

const getAssetPath = (...paths: string[]): string => {
  return path.join(RESOURCES_PATH, ...paths);
};

/**
 * DANGEROUS FUNCTION: Clears the app cache
 * Sometimes the app cache gets corrupted and needs to be cleared
 * @param mainWindow
 */
const clearAppCache = async (mainWindow: BrowserWindow) => {
  await session.defaultSession.clearStorageData();
  await clearStore();
  await mainWindow.webContents.session.clearCache();
  await mainWindow.webContents.session.clearStorageData();

  await session.defaultSession.clearStorageData();
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    show: false,
    width: Math.round(screen.getPrimaryDisplay().workAreaSize.width * 0.75),
    height: Math.round(screen.getPrimaryDisplay().workAreaSize.height * 0.88),
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      // nodeIntegration: true,
      devTools: isDebug,
      nodeIntegrationInWorker: true,
      spellcheck: true,
      webSecurity: app.isPackaged, // disable CORS in dev (renderer served from localhost:1212, backend on 127.0.0.1:8000)
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: isWindows ? false : true,
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    title: 'Constella',
  });

  // setup the language
  // mainWindow.webContents.session.setSpellCheckerLanguages(['en-US', 'fr']);

  // Rright click handle from main process
  mainWindow.webContents.on('context-menu', (event, params) => {
    // Send right click data to the render process
    mainWindow?.webContents.send('context-menu', { params });
  });

  // [debug] Forward renderer console warnings/errors + our trace-tagged logs to
  // the main-process stdout so they land in the dev log file (greppable). Keeps
  // noise down by filtering to levels >= warn and a small set of debug prefixes.
  mainWindow.webContents.on(
    'console-message',
    (_e, level, message, line, sourceId) => {
      const isTraced =
        /\[(homeDiscovery|MindmapStreamConductor|HomeDiscoverySplit|NotesFlowView|ai-pipeline|RecallChat|StellaRecall)\]/.test(
          message,
        );
      if (level >= 2 || isTraced) {
        const src = (sourceId || '').split('/').pop();
        // eslint-disable-next-line no-console
        console.log(`[renderer:${level}] ${message}  (${src}:${line})`);
      }
    },
  );

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  // show only after it's ready to show to make it smoother
  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    // start minimized for certain windows like quick scope
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  try {
    // set traffic lights position
    mainWindow.setWindowButtonPosition({ x: 11, y: 10 });
  } catch (e) {
    log.error('Error setting window button position', e);
  }

  // Delay on close
  // IMPORTANT: causing issues with auto updater
  // mainWindow.on('close', function (e) {
  //   // Skip on debug mode
  //   if (!delayedCloseAlready && !isDebug) {
  //     delayedCloseAlready = true;
  //     // send event to renderer to show loading
  //     mainWindow?.webContents.send('closing-window');

  //     // delay by 6.5 seconds to make sure the debounced title update finishes
  //     setTimeout(function () {
  //       mainWindow?.close();
  //     }, 4500);
  //     e?.preventDefault();
  //   }
  // });

  // clearAppCache(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // If the user explicitly surfaces the main window (show/restore), hide the
  // overlay so it doesn't sit on top of the desktop app. We no longer listen
  // for `focus` here: with the overlay now a non-activating panel, focusing
  // the overlay must not cause the main window to receive a spurious focus
  // event that races the overlay's own show.
  mainWindow.on('restore', () => {
    hideSearchOverlay();
  });

  mainWindow.on('show', () => {
    // If the 'show' was triggered by macOS un-hiding the app on overlay
    // panel show (after a previous `app.hide()`), keep the overlay visible
    // and re-hide the main window. Otherwise the user surfaced the main
    // window themselves — hide the overlay so it doesn't sit on top.
    if (suppressNextMainSurface) {
      suppressNextMainSurface = false;
      mainWindow?.hide();
      return;
    }
    hideSearchOverlay();
  });

  // If the overlay was explicitly pinned via shortcut, re-show it when the app
  // is backgrounded (app switching, clicking another app, etc.).
  // Use a small delay so Electron updates focus state first.
  mainWindow.on('blur', () => {
    if (!isSearchOverlayPinned) return;
    setTimeout(() => {
      showSearchOverlay();
    }, 100);
  });

  // If the overlay was pinned, show it when the main window is minimized.
  mainWindow.on('minimize', () => {
    if (!isSearchOverlayPinned) return;
    setTimeout(() => {
      showSearchOverlay();
    }, 100);
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  if (isDebug) {
    setTimeout(() => {
      mainWindow?.webContents.openDevTools({ mode: 'right' });
    }, 3000);
  }

  // Auto updater init
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

setupDeepLinks();

/**
 * Perform app startup tasks
 */
app
  .whenReady()
  .then(() => {
    // create window
    createWindow();

    // Pin the full-color Constella icon on the macOS Dock so dev builds show
    // the same green icon as the production bundle (which uses icon.icns).
    // BrowserWindow's `icon` prop only sets the window/taskbar icon on macOS —
    // the Dock icon must be set explicitly via app.dock.setIcon().
    if (isMac && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(getAssetPath('icon.png')));
    }

    // Initialize overlay window (but don't show it yet)
    createSearchOverlayWindow();

    // Pre-fork the local LLM worker so the first local recall doesn't pay
    // the spawn + model-load cost on the user's keystroke.
    startProviders();

    // Load the persisted onboarding user-context (role + persona) into the
    // sync cache so the local AI prompt builders can prepend it from the
    // first request. The renderer re-mirrors it on mount too.
    require('./userContext')
      .hydrateUserContext()
      .catch(() => undefined);

    // Start the in-app MCP "brain" server (auto-heals via its own watchdog) so
    // the claude/codex CLI providers can query the user's knowledge base.
    startAppMcpServer().catch((e) => {
      console.warn('[mcp] failed to start:', e?.message || e);
    });

    // File indexing: request Full Disk Access (macOS) if needed, then register
    // the preset folders so the sync loop has sources to index. Deferred a few
    // seconds so the FDA dialog doesn't fight the window's first paint.
    setTimeout(() => {
      runFileIndexStartup().catch(() => {
        /* best-effort */
      });
    }, 4000);

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) {
        createWindow();
      } else {
        // If window exists but is minimized, restore it
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        hideSearchOverlay();
      }
    });

    // TODO: search window
    // searchWindow = createSearchWindow();

    //tray icon
    const iconName = getAssetPath('iconTemplate.svg');
    const iconPath = iconName;

    // register app open shortcut
    let defaultShortcut = isMac ? 'Command+Option+C' : 'Ctrl+Alt+C';
    getStoreValue(
      STORE_KEYS.SHORTCUTS.quickOpenConstella,
      defaultShortcut,
    ).then((shortcut) => {
      // A persisted modifier-only value (from a half-finished rebind) makes
      // register() throw — fall back to the default so the hotkey still works,
      // and heal the store so Settings shows a valid value.
      const accelerator = hasRealKey(shortcut) ? shortcut : defaultShortcut;
      if (!hasRealKey(shortcut)) {
        void setStoreValue(
          STORE_KEYS.SHORTCUTS.quickOpenConstella,
          defaultShortcut,
        );
      }
      try {
        globalShortcut.register(accelerator, () => {
          mainWindow?.show();
          // Also send a message to focus the search input
          mainWindow?.webContents.send('focus-search-input', {});
        });
      } catch (error) {
        console.error('Error registering quick-open shortcut:', error);
      }
    });

    // register search overlay toggle shortcut
    // The configured hotkey (default Cmd+Shift+O, editable in Settings →
    // Shortcuts) always toggles the quick-capture overlay, regardless of what
    // else is focused. The overlay is a non-activating panel, so showing it
    // does not raise the main window.
    const DEFAULT_OVERLAY_SHORTCUT = 'Command+Shift+O';
    // Shared toggle bound to whatever accelerator is currently registered — the
    // boot registration and the runtime rebind handler both point at this.
    const toggleSearchOverlay = () => {
      if (isSearchOverlayVisible()) {
        isSearchOverlayPinned = false;
        hideSearchOverlay();
      } else {
        isSearchOverlayPinned = true;
        if (isMac) {
          // Arm the suppression flag so the about-to-fire 'show' event on
          // mainWindow (from macOS un-hiding the app) re-hides the main
          // window rather than hiding the overlay. Auto-clear after a beat
          // in case no 'show' fires (e.g., main window was already hidden).
          suppressNextMainSurface = true;
          setTimeout(() => {
            suppressNextMainSurface = false;
          }, 300);
        }
        showSearchOverlay();
      }
    };

    // Tracks the accelerator currently bound to the overlay so a runtime rebind
    // can unregister exactly what's live. We register the default on first run
    // WITHOUT persisting it, so the store can be empty even though a shortcut is
    // active — trusting the store to find the old binding would leave the old
    // accelerator registered (both old + new firing). This variable is the
    // source of truth instead.
    let currentOverlayShortcut = DEFAULT_OVERLAY_SHORTCUT;

    getStoreValue(
      STORE_KEYS.SHORTCUTS.showSearchOverlay,
      DEFAULT_OVERLAY_SHORTCUT,
    ).then((shortcut) => {
      // Reject a modifier-only persisted value (e.g. "Command+Shift" left by a
      // half-finished rebind) — register() throws on it, leaving NO overlay
      // shortcut. Fall back to the default and heal the store.
      currentOverlayShortcut = hasRealKey(shortcut)
        ? shortcut
        : DEFAULT_OVERLAY_SHORTCUT;
      if (!hasRealKey(shortcut)) {
        void setStoreValue(
          STORE_KEYS.SHORTCUTS.showSearchOverlay,
          DEFAULT_OVERLAY_SHORTCUT,
        );
      }
      try {
        globalShortcut.register(currentOverlayShortcut, toggleSearchOverlay);
      } catch (error) {
        console.error('Error registering overlay shortcut:', error);
      }
    });

    // Lets the renderer (Settings → Shortcuts) rebind the overlay hotkey at
    // runtime: unregister whatever is actually live, register + persist the new
    // one, all bound to the same toggle callback. Returns false if the new
    // accelerator is reserved/invalid (in which case we restore the old one so
    // the user isn't left with no overlay shortcut).
    ipcMain.handle('set-overlay-shortcut', async (_event, value: string) => {
      try {
        // Reject empty or modifier-only accelerators up front so a bad value
        // never gets persisted (and re-breaks the shortcut on next boot).
        if (!value || !hasRealKey(value)) return false;

        // Release the accelerator that's currently firing the overlay.
        if (currentOverlayShortcut) {
          try {
            globalShortcut.unregister(currentOverlayShortcut);
          } catch (error) {
            // ignore — the register below is what actually matters
          }
        }

        // `register` is a no-op (returns false) for reserved combos and can
        // throw for malformed ones — treat both as failure and restore.
        let registered = false;
        try {
          globalShortcut.register(value, toggleSearchOverlay);
          registered = globalShortcut.isRegistered(value);
        } catch (error) {
          registered = false;
        }

        if (!registered) {
          // Restore the previous binding so the overlay stays reachable.
          try {
            globalShortcut.register(
              currentOverlayShortcut,
              toggleSearchOverlay,
            );
          } catch (error) {
            // best-effort restore
          }
          return false;
        }

        currentOverlayShortcut = value;
        await setStoreValue(STORE_KEYS.SHORTCUTS.showSearchOverlay, value);
        return true;
      } catch (error) {
        console.error('Error in set-overlay-shortcut:', error);
        return false;
      }
    });

    if (isDebug) {
      installExtension(REACT_DEVELOPER_TOOLS)
        .then((name) => console.log(`Added Extension:  ${name}`))
        .catch((err) => console.log('An error occurred: ', err));
    }

    protocol.handle('constella-file-protocol', async (request: Request) => {
      const filePath = request.url.replace(LOCAL_FILE_PROTOCOL, 'file://');
      return net.fetch(filePath);
    });
    //initial the tray
    // let tray = new Tray(iconPath);

    //this toolTip is for when you hover the tray icon will show the title
    //I just take the title from index.html
    // tray.setToolTip('Constella');

    // const contextMenu = Menu.buildFromTemplate([
    //   {
    //     label: 'Search',
    //     click: () => {
    //       searchWindowShow();
    //     },
    //     accelerator: WINDOW_SHORTCUT,
    //   },
    //   {
    //     label: 'Hide Search',
    //     click: () => {
    //       searchWindow?.hide();
    //     },
    //   },

    //   { role: 'quit' },
    // ]);

    // tray.setContextMenu(contextMenu);

    new AppUpdater();

    try {
      let loadingInModels = false;
      const progressCallback = (step: Record<string, any>) => {
        if (
          step['status'] === 'progress' &&
          step['progress'] < 100 &&
          !loadingInModels
        ) {
          loadingInModels = true;
          setTimeout(() => {
            mainWindow?.webContents.send('show-update-message', {
              message: `Loading in Constella's models, please wait...`,
            });
          }, 3000);
        } else if (step['status'] === 'done' && loadingInModels) {
          setTimeout(() => {
            mainWindow?.webContents.send('show-update-message', {
              message: `Models loaded!`,
            });
          }, 3000);
        }
      };
      getImageToTextPipeline(progressCallback);
      // Warm the local text embedder (EmbeddingGemma) on first open, mirroring how
      // the old all-MiniLM pipeline was warmed here. Fire-and-forget: it auto-
      // downloads the GGUF (~334 MB) once if missing, then loads it, so local
      // file-index + recall embeddings work without a manual step. Non-blocking.
      getEmbeddingService()
        .loadIfNeeded()
        .catch((err) =>
          console.error('[Embedding] startup warm failed:', err),
        );
    } catch (e) {
      console.error('Error initializing pipelines:', e);
    }
  })
  .catch(console.log);

// Unregister shortcuts on quit
app.on('will-quit', () => {
  // Unregister all shortcuts.
  globalShortcut.unregisterAll();
  // Tear down the local LLM worker process.
  stopProviders();
  // Tear down the embedding worker process (via the service facade).
  void getEmbeddingService().dispose();
  // Stop the file-index sync loop + flush any pending progress to disk.
  stopFileIndexLoop();
  // Stop the knowledge-graph engine + flush its cluster/concept state.
  stopGraphScheduler();
  flushFileIndexProgress();
  // Stop the MCP server + its watchdog.
  stopAppMcpServer().catch(() => undefined);
  // Drain + WAL-checkpoint + stop the main-DB worker (best-effort; WAL
  // recovers cleanly even from a hard kill).
  void closeMainDb();
});

// listen for browser window active
app.on('browser-window-focus', () => {
  // send message to renderer to sync
  mainWindow?.webContents.send('browser-window-focus', {});
});

// TODO: THIS CODE IS NOT WORKING AND CAUSED ISSUES FOR USERS
// try {
//   // Check if we've already set login item to avoid conflicts with Windows auto-updater
//   getStoreValue(STORE_KEYS.GENERAL.hasSetLoginItem, 'NOT_SET').then((value) => {
//     if (value === 'NOT_SET') {
//       console.log('Setting login item!');
//       // Only set login item if we haven't done it before
//       app.setLoginItemSettings({
//         openAtLogin: true,
//       });
//       // Mark that we've set the login item
//       setStoreValue(STORE_KEYS.GENERAL.hasSetLoginItem, 'true');
//     }
//   });
// } catch (e) {
//   console.error('Error setting login item settings', e);
// }

/* Auto Updater Events */

/**
 * On update downloaded, show toast via main window
 * and then update with a delay to ensure successful installation
 * (ShipIt scripts take a long time to copy over the files)
 */
autoUpdater.on('update-downloaded', (updateInfo) => {
  log.info('Update downloaded');
  try {
    // if main window, send message to show toast notification
    setTimeout(() => {
      if (mainWindow) {
        mainWindow.webContents.send('update-available', {
          releaseNotes:
            updateInfo?.releaseNotes ?? 'Minor fixes and improvements',
        });
      }
      // try sending system notification too (but may not work if no notifications)
      new Notification({
        title: 'Update downloaded!',
        body: 'Restarting with updates automatically...',
      }).show();
    }, 2000);
  } catch (e) {
    log.error('Error showing notification', e);
  }

  setTimeout(() => {
    autoUpdater.quitAndInstall();
    globalShortcut.unregisterAll();
    app.exit();
  }, 40000); // Need a long delay to allow the update to be copied over
});

let lastProgressUpdate = -1;
autoUpdater.on('download-progress', (info) => {
  try {
    // Show the first 1% and then every 10%
    if (
      mainWindow &&
      ((info.percent >= 1 && lastProgressUpdate < 1) ||
        info.percent - lastProgressUpdate >= 10)
    ) {
      mainWindow.webContents.send('show-update-message', {
        message: `Downloading update progress: ${Math.floor(info.percent)}%`,
      });
      lastProgressUpdate = info.percent;
    }
  } catch (e) {
    log.error('Error sending update-available event', e);
  }
});

// autoUpdater.on('error', (info) => {
//   try {
//     if (mainWindow) {
//       mainWindow.webContents.send('show-update-message', {
//         message: `Error downloading update: ${info.message}\n\n ${
//           info.stack
//         } \n\n ${info?.cause ?? ''} \n\n ${info?.name ?? ''}`,
//         duration: 20000,
//       });
//     }
//   } catch (e) {
//     log.error('Error sending update-available event', e);
//   }
// });

/**
 * There is an update available, but it's not yet downloaded
 */
autoUpdater.on('update-available', (info) => {
  try {
    if (mainWindow) {
      dialog
        .showMessageBox({
          type: 'info',
          title: 'A new update!',
          message: 'A new update is available! Do you want to update now?',
          buttons: ['Sure', 'Later'],
        })
        .then((buttonIndex) => {
          if (buttonIndex.response === 0) {
            autoUpdater.downloadUpdate();
          }
        });
      lastProgressUpdate = 0;
    }
  } catch (e) {
    log.error('Error sending update-available event', e);
  }
});
