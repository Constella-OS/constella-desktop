// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';

// possible channels that can be sent to main, just a type
export type Vector_Channels =
  | 'embed-text'
  | 'embed-text-worker'
  | 'embed-image'
  | 'embed-image-worker'
  | 'image-to-text-worker'
  | 'embed-file';
export type Search_Window_Channels = 'set-height';
export type Settings_Channels =
  | 'export-notes'
  | 'import-notes'
  | 'reset-app'
  | 'relaunch-app';
export type Storage_Channels =
  | 'save-blob'
  | 'save-pdf-to-documents'
  | 'get-image-from-files'
  | 'get-local-file-path'
  | 'delete-file'
  | 'upload-file'
  | 'export-to-file';
export type Window_Channels =
  | 'replace-misspelling'
  | 'close-window'
  | 'minimize-window'
  | 'restore-main-window'
  | 'toggle-maximize-window'
  | 'check-for-updates'
  | 'get-device-id'
  | 'request-microphone-permission';
export type Misc_Channels = 'get-locale';

// LLM Tool Calling Channels
export type LLM_Channels =
  | 'llm-initialized'
  | 'llm-model-loaded'
  | 'llm-model-unloaded'
  | 'llm-session-created'
  | 'llm-session-cleared'
  | 'llm-config-updated'
  | 'llm-download-progress'
  | 'llm-download-completed'
  | 'llm-download-error'
  | 'llm-download-cancelled'
  | 'llm-tools-toggled'
  | 'llm-tool-calls-executed'
  | 'llm-stream-token'
  | 'llm-stream-error';

export type Outgoing_Channels =
  | Vector_Channels
  | Search_Window_Channels
  | Settings_Channels
  | Window_Channels
  | Storage_Channels
  | Misc_Channels;

// On deep link received, they send event back to the auth
export type Deep_Link_Responses =
  | 'auth-deep-link'
  | 'connect-subscription-deep-link'
  | 'integrations-deep-link'
  | 'install-workflow-deep-link'
  | 'subscription-upgrade-success';

export type Incoming_channels =
  | 'context-menu'
  | 'update-available'
  | 'closing-window'
  | 'browser-window-focus'
  | 'show-update-message'
  | 'focus-search-input'
  | 'overlay-create-note'
  | 'overlay-tags-snapshot'
  | 'overlay-tags-request'
  | 'overlay-search-request'
  | 'overlay-search-results'
  | 'overlay-open-note'
  | 'provider:event'
  | 'provider:status'
  // MCP "brain" server asks the main renderer to run a search / fetch a note
  // (renderer owns auth + the real search + RxDB); reply via mcp:result-internal.
  | 'mcp:request'
  // Local file indexing: main streams built records / deletions to the renderer
  // which owns RxDB (see file-index/syncService.ts + the renderer coordinator).
  | 'file-index:records'
  | 'file-index:deletions'
  // Local knowledge-graph engine: streams concept/theme records to the
  // Discoveries graph coordinator (see file-graph/emit.ts).
  | 'file-graph:records'
  | 'file-graph:deletions'
  | 'file-graph:connections'
  // Main DB (sqlite in main): broadcast after any collection write so
  // renderer-side caches can react; payload is a DbChangedEvent.
  | 'db:changed'
  | Deep_Link_Responses
  | LLM_Channels;

const electronHandler = {
  ipcRenderer: {
    // send a message on the channel
    sendMessage(channel: Outgoing_Channels, args: Record<string, any>) {
      ipcRenderer.send(channel, args);
    },
    // listen for a message on the channel
    on(channel: Incoming_channels, func: (args: Record<string, any>) => void) {
      const subscription = (
        _event: IpcRendererEvent,
        args: Record<string, any>,
      ) => func(args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    // unsubscribe and then listen
    unsubscribeAndOn(
      channel: Outgoing_Channels,
      func: (args: Record<string, any>) => void,
    ) {
      const subscription = (
        _event: IpcRendererEvent,
        args: Record<string, any>,
      ) => func(args);

      // First remove any existing listener
      ipcRenderer.removeListener(channel, subscription);

      // Then subscribe to the channel
      ipcRenderer.on(channel, subscription);
    },
    // just listen for a message on the channel once
    once(
      channel: Outgoing_Channels,
      func: (args: Record<string, any>) => void,
    ) {
      ipcRenderer.once(channel, (_event, args) => func(args));
    },
    // if a handle exists for that method, calls that handler in main
    invoke: (method: string, args: any) => ipcRenderer.invoke(method, args),
    // remove all listeners for this channel
    removeAllListeners(channel: string) {
      ipcRenderer.removeAllListeners(channel);
    },
    postMessage(channel: string, message: string, args: any) {
      ipcRenderer.postMessage(channel, message, args);
    },
  },
  open: (path: string) => {
    ipcRenderer.send('open', path);
  },
  // Opens an http(s) URL in the user's default browser. Distinct from `open`
  // above, which hits shell.openPath() for local file paths and silently fails
  // on URLs.
  openExternal: (url: string) => {
    ipcRenderer.send('open-external', url);
  },
  setHeight: (height: number) => {
    ipcRenderer.send('set-height', height);
  },
  focus: (callback: any) => {
    ipcRenderer.on('focus', callback);
    return () => {
      ipcRenderer.removeListener('focus', callback);
    };
  },
  // Electron 32+ removed `File.path` for security. webUtils.getPathForFile is
  // the replacement: hand it a renderer File object and it returns the absolute
  // OS path so the main process can read/copy the dropped file.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
