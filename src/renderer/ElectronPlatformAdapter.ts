import llmAPI from '../utils/api/llm-api';
import type {
	PlatformAdapter,
	Unsubscribe,
} from '../platform/PlatformAdapter';

// Thin ipcRenderer convenience accessor. Every call site in this file goes through the
// preload-exposed bridge; no direct `require('electron')` happens here (renderer context).
const ipc = () => window.electron.ipcRenderer;

// Desktop implementation of the shared PlatformAdapter interface. Every method is a thin
// passthrough to an existing IPC channel or to the pre-existing llmAPI singleton, so
// behavior matches the pre-refactor renderer exactly. PR 1 ships this alongside the
// interface; later PRs migrate call sites to use this adapter via usePlatform() instead
// of reaching for window.electron.ipcRenderer directly.
export function createElectronPlatformAdapter(): PlatformAdapter {
	return {
		name: 'desktop',
		capabilities: {
			localLLM: true,
			localEmbeddings: true,
			multiWindow: true,
			nativeFileSystem: true,
			nativeAutoUpdate: true,
			deepLinks: true,
			globalShortcuts: true,
			instantSyncing: true,
			voiceConvo: true,
		},

		// Storage on desktop today is window.localStorage inside the Electron renderer —
		// keep that exact semantic here so PR 1 is behaviorally a no-op. A later PR may
		// swap to electron-store via IPC for native-durability if we want parity with
		// how main-process settings persist.
		storage: {
			get: (key) => window.localStorage.getItem(key),
			set: (key, value) => window.localStorage.setItem(key, value),
			remove: (key) => window.localStorage.removeItem(key),
		},

		window: {
			// Main-process handlers for these channels are registered via
			// ipcMain.handle, so the renderer must use invoke (not sendMessage).
			minimize: () => {
				void ipc().invoke('minimize-window', {});
			},
			maximize: () => {
				void ipc().invoke('toggle-maximize-window', {});
			},
			close: () => {
				void ipc().invoke('close-window', {});
			},
			restore: () => {
				void ipc().invoke('restore-main-window', {});
			},
			focus: () => {
				void ipc().invoke('focus', {});
			},
			// Two set-height paths exist on desktop: the main BrowserWindow (invoked
			// via the typed sendMessage channel with {height} arg) and the search
			// sub-window (invoked via window.electron.setHeight). The adapter targets
			// the main window here; SearchUI still uses sendMessage directly for now.
			setHeight: (px) => window.electron.setHeight(px),
			onFocus: (cb) => {
				const unsubscribe = window.electron.focus(() => cb());
				return unsubscribe as Unsubscribe;
			},
		},

		shell: {
			openExternal: (url) => window.electron.openExternal(url),
			getDeviceId: () => ipc().invoke('get-device-id', {}) as Promise<string>,
			getLocale: () => ipc().invoke('get-locale', {}) as Promise<string>,
		},

		updates: {
			// Uses invoke to match existing call sites; main-process handler is
			// registered via ipcMain.handle for this channel.
			checkForUpdates: () => {
				void ipc().invoke('check-for-updates', {});
			},
			// "update-available" is the auto-updater's release-notes payload.
			onUpdateAvailable: (cb) => ipc().on('update-available', (info) => cb(info)),
			relaunch: () => {
				void ipc().invoke('relaunch-app', {});
			},
		},

		files: {
			saveBlob: (args) => ipc().invoke('save-blob', args) as Promise<string>,
			savePdf: (args) =>
				ipc().invoke('save-pdf-to-documents', args) as Promise<string>,
			getImage: (args) =>
				ipc().invoke('get-image-from-files', args) as Promise<string>,
			getLocalFilePath: (args) =>
				ipc().invoke('get-local-file-path', args) as Promise<string>,
			deleteFile: (args) => ipc().invoke('delete-file', args) as Promise<void>,
			openWithNativeApp: (args) =>
				ipc().invoke('open-file-with-native-app', args) as Promise<void>,
			uploadFile: (args) =>
				ipc().invoke('upload-file', args) as Promise<{ url: string }>,
			checkExists: (args) =>
				ipc().invoke('check-file-exists', args) as Promise<{
					fullPath: string;
					exists: boolean;
				}>,
			exportNotes: (args) => ipc().invoke('export-notes', args),
			exportToFile: (args) => ipc().invoke('export-to-file', args),
		},

		embeddings: {
			embedText: (args) =>
				ipc().invoke('embed-text', args) as Promise<number[]>,
			embedTextWorker: (args) =>
				ipc().invoke('embed-text-worker', args) as Promise<number[]>,
			embedImage: (args) =>
				ipc().invoke('embed-image', args) as Promise<{
					imageText: string;
					embedding: number[];
				}>,
			embedFile: (args) =>
				ipc().invoke('embed-file', args) as Promise<number[]>,
		},

		// LLM IS the pre-existing llmAPI singleton (src/utils/api/llm-api.ts). No wrapping,
		// no duplicate instance — that singleton owns all IPC stream listener state and
		// instantiating a second one would emit every streamed token twice.
		llm: llmAPI,

		// Auth PR 1 note: sign-in triggers are placeholders until PR 3 migrates the
		// ConnectAccountModal + deep-link flow behind the adapter. Call sites still use
		// the existing (non-adapter) wiring, so these stubs are unreachable from live
		// UI — they exist only to satisfy the interface and will throw loudly if a
		// future migration tries to use them before PR 3 wires them up.
		auth: {
			signInWithGoogle: async () => {
				throw new Error(
					'auth.signInWithGoogle is not available on desktop — ConnectAccountModal opens the website + waits for an auth-deep-link instead.',
				);
			},
			signInWithApple: async () => {
				throw new Error(
					'auth.signInWithApple is not available on desktop — ConnectAccountModal owns the flow.',
				);
			},
			// Email/password flows are never called on desktop: the ConnectAccountModal web
			// path hosts the AuthForm; desktop routes the user through the website browser
			// to pick up a deep-link callback. These throw loudly so any accidental call
			// surfaces immediately instead of silently going nowhere.
			signInWithEmail: async () => {
				throw new Error(
					'auth.signInWithEmail is not available on desktop — uses ConnectAccountModal + deep-link flow.',
				);
			},
			signUpWithEmail: async () => {
				throw new Error(
					'auth.signUpWithEmail is not available on desktop — uses ConnectAccountModal + deep-link flow.',
				);
			},
			sendPasswordReset: async () => {
				throw new Error(
					'auth.sendPasswordReset is not available on desktop — uses ConnectAccountModal + deep-link flow.',
				);
			},
			signOut: async () => {
				throw new Error(
					'auth.signOut not wired yet on desktop.',
				);
			},
			onAuthStateChanged: () => () => {},
			mintBackendAccessToken: () =>
				ipc().invoke('mint-access-token', {}) as Promise<string>,
			// Uses invoke (not sendMessage) to match existing call sites like
			// UserStore.tsx — the main-process handler is registered via ipcMain.handle.
			setBackendAccessToken: (token) => {
				void ipc().invoke('set-access-token', { token });
			},
			// Forwards both flavors of deep-link payload (sign-in and subscription-connect)
			// to the caller so the adapter consumer doesn't need to know about channel names.
			onDeepLink: (cb) => {
				const u1 = ipc().on('auth-deep-link', (payload) =>
					cb(payload as Record<string, string>),
				);
				const u2 = ipc().on('connect-subscription-deep-link', (payload) =>
					cb(payload as Record<string, string>),
				);
				return () => {
					u1();
					u2();
				};
			},
		},

		// PDF worker URL: PR 6 migrates the workerURL constant from App.tsx behind this
		// method (the webpack `new URL(..., import.meta.url)` expression currently
		// lives at App.tsx module top). For PR 1 we return empty and keep the existing
		// App.tsx constant in place — no call sites read this yet.
		assets: {
			pdfWorkerUrl: () => '',
		},

		activity: {
			markInteractive: () => {
				void ipc().invoke('provider:interactive-activity', {});
			},
		},
	};
}
