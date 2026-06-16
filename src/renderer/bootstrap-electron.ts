import axios from 'axios';
import { setPlatform } from '../platform/platformInstance';
import { createElectronPlatformAdapter } from './ElectronPlatformAdapter';
import { init, browserTracingIntegration } from '@sentry/electron/renderer';
import { captureConsoleIntegration } from '@sentry/browser';
import { IS_DEV_ENV } from '../main/constants';
import { initFileIndexCoordinator } from '../utils/file-index/coordinator';
import { initFileGraphCoordinator } from '../utils/file-graph/coordinator';
import { maybeAutoStartEmbeddingReindex } from '../utils/reindex/embeddingReindex';
import { ensureMainDbMigrated } from '../db/migrate-to-maindb';
import { DEFAULT_PROVIDER } from '../utils/providers';

// Side-effect-only module: import this FIRST in src/renderer/index.tsx so the platform
// singleton is populated before any store, axios interceptor, or utility module that uses
// getPlatform() is evaluated. ES module evaluation order guarantees this as long as the
// import statement for this file appears ahead of any import that transitively reaches
// getPlatform().
setPlatform(createElectronPlatformAdapter());

// Forward uncaught renderer errors + promise rejections to main over IPC so they
// land in the persisted engine log (<userData>/logs/engine-<date>.log). A
// crashing renderer never emits a 'console-message', so without this a renderer
// error that precedes a crash (e.g. in the PDF-expand path) leaves no trace.
// Best-effort + guarded so the reporter can never itself throw.
try {
  const reportRendererError = (label: string, detail: unknown) => {
    try {
      const msg =
        detail instanceof Error
          ? `${detail.message}\n${detail.stack ?? ''}`
          : typeof detail === 'string'
            ? detail
            : JSON.stringify(detail);
      // The preload exposes `sendMessage(channel, args)`, not a raw `send`.
      window.electron?.ipcRenderer?.sendMessage('app:renderer-error' as any, {
        msg: `${label}: ${msg}`,
      });
    } catch {
      /* never let error reporting throw */
    }
  };
  window.addEventListener('error', (e) =>
    reportRendererError('window.onerror', e?.error || e?.message),
  );
  window.addEventListener('unhandledrejection', (e) =>
    reportRendererError(
      'unhandledrejection',
      (e as PromiseRejectionEvent)?.reason,
    ),
  );
} catch {
  /* ignore — environment without window/ipc */
}

// Cross-device identity: stamp every renderer backend call with this device's
// id. The backend writes it onto records as lastUpdateDeviceId, and relay_pull
// excludes records we last wrote — other devices' notes relay down, ours never
// echo back. Async, but resolves in ms (well before any user-driven push).
window.electron?.ipcRenderer
  ?.invoke('get-device-id', {})
  .then((deviceId: string) => {
    if (deviceId) axios.defaults.headers.common['device-id'] = deviceId;
  })
  .catch((e: unknown) =>
    console.warn('[device-id] failed to set renderer axios header:', e),
  );

// Mirror the user's selected AI provider to the main process (electron-store
// `graph.provider`) on EVERY boot. `SearchStore.setSelectedProvider` only fires
// the `file-graph:set-provider` IPC on an EXPLICIT change, so a user who keeps
// the default ('cloud') — or whose pick predates this sync — never wrote
// `graph.provider`. The background knowledge-graph engine then reads an empty
// pref and silently falls back to a local CLI (claude/codex), or skips
// connections entirely when no CLI exists — so the cloud `graph_llm` proxy is
// never called even though the UI shows "Constella" selected. This boot mirror
// makes the engine honor the actual selected provider without a re-click.
try {
  const selectedProvider =
    (typeof localStorage !== 'undefined' &&
      localStorage.getItem('selectedProvider')) ||
    DEFAULT_PROVIDER;
  window.electron?.ipcRenderer
    ?.invoke('file-graph:set-provider', selectedProvider)
    .catch(() => {
      /* non-fatal */
    });
} catch {
  /* electron absent (web) / storage error — non-fatal */
}

// One-time legacy-RxDB → main-process sqlite copy, THEN subscribe to the
// main-process record streams. Ordering matters: the file-index coordinator
// sends `file-index:renderer-ready` (which releases main's first index sync),
// so initializing it only after the migration resolves guarantees no
// concurrent file-index writes land mid-copy. ensureMainDbMigrated() never
// rejects and no-ops once the done-flag exists, so a healthy boot adds one
// IPC round-trip.
ensureMainDbMigrated().finally(() => {
  // Locally indexed files land in the main DB via these streams. Desktop-only;
  // this module is never bundled by web.
  initFileIndexCoordinator();
  // Knowledge-graph engine's concept/theme record stream for the Discoveries
  // graph. Desktop-only.
  initFileGraphCoordinator();

  // Parity harness: compares every retrieval function against the untouched
  // legacy RxDB copy. Manual: window.__runDbParityCheck() in devtools; dev
  // builds also auto-run it once shortly after boot (lazy import keeps rxdb
  // out of the boot path when the check isn't used).
  const runParity = () =>
    import('../db/parity-check').then((m) => m.runDbParityCheck());
  (window as any).__runDbParityCheck = runParity;
  if (IS_DEV_ENV) {
    setTimeout(() => {
      runParity().catch((e) => console.error('[parity] auto-run failed', e));
    }, 12000);
  }
});

// Fire-once 384→512 embedding reindex: rebuilds the local LanceDB vector store at
// the EmbeddingGemma dimension so the graph engine's vector search stops mismatching
// (the cause of the empty graph). Deferred so it doesn't contend with first paint;
// internally no-ops once the persisted marker exists. Fire-and-forget.
setTimeout(() => {
  maybeAutoStartEmbeddingReindex().catch((e) =>
    console.error('[Reindex] autostart failed', e),
  );
}, 8000);

// Sentry (Electron renderer flavor) is initialized here rather than inside the shared
// App.tsx so the shared renderer can build for web under Vite without pulling
// @sentry/electron/renderer — its module-load code touches Electron APIs that don't
// exist in a browser. Web's bootstrap (web/src/bootstrap-web.ts) intentionally skips
// Sentry entirely.
if (!IS_DEV_ENV) {
	init({
		integrations: [
			browserTracingIntegration(),
			captureConsoleIntegration({ levels: ['error'] }),
		],
		tracesSampleRate: 1.0,
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 0,
		attachStacktrace: true,
	});
}
