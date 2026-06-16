/**
 * MCP → renderer bridge (main process).
 *
 * The MCP tools run in the main process, but the user's knowledge base content
 * lives where the renderer can reach it: the backend (auth token + the real
 * hybrid search) and the local RxDB mirror. Rather than re-implement search in
 * main (and drift from the app's actual retrieval), the search/get-note tools
 * round-trip to the main renderer — exactly how the search overlay already
 * borrows the renderer's auth + search (see main.ts `overlay-search`).
 *
 * Flow:
 *   tool handler → mcpRendererRequest(op, payload)
 *     → main sends `mcp:request` { requestId, op, ...payload } to the main window
 *     → renderer (useSearchOverlayBridge) runs the real search / note fetch
 *     → renderer invokes `mcp:result-internal` { requestId, ok, data, error }
 *     → we resolve/reject the pending promise (with a timeout safety net).
 *
 * If no main window is alive (logged out, not booted yet), the request rejects
 * with a clear message the tool surfaces to the agent rather than hanging.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let getWindow: (() => BrowserWindow | null) | null = null;
let registered = false;

/**
 * Wire the bridge. `getMainWindow` returns the main renderer window (the one
 * that owns auth + RxDB), or null if it isn't available. Call once from main.ts
 * where `mainWindow` is in scope.
 */
export function registerMcpBridge(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow;
  if (registered) return;
  registered = true;

  // Renderer's reply lands here and resolves the matching pending request.
  ipcMain.handle(
    'mcp:result-internal',
    (
      _e,
      payload: { requestId?: string; ok?: boolean; data?: unknown; error?: string },
    ) => {
      const requestId = payload?.requestId;
      if (!requestId) return;
      const p = pending.get(requestId);
      if (!p) return; // already timed out / unknown
      pending.delete(requestId);
      clearTimeout(p.timer);
      if (payload.ok) p.resolve(payload.data);
      else p.reject(new Error(payload.error || 'renderer request failed'));
    },
  );
}

/**
 * Ask the renderer to run one MCP-backing operation and await its reply.
 * `op` is 'search' | 'multi-search' | 'get-note' | 'create-note'; payload
 * carries op-specific args. Rejects if the renderer isn't available or doesn't
 * answer within `timeoutMs`.
 */
export function mcpRendererRequest(
  op:
    | 'search'
    | 'multi-search'
    | 'get-note'
    | 'create-note'
    | 'create-pdf'
    | 'agent:list'
    | 'agent:get'
    | 'agent:create'
    | 'agent:update'
    | 'agent:delete'
    | 'agent:run'
    | 'workflow:get'
    | 'workflow:update-node'
    | 'agent:chat-history'
    | 'agent:run-status',
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<unknown> {
  const win = getWindow?.() ?? null;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return Promise.reject(
      new Error('knowledge base is not available (app window not ready)'),
    );
  }
  const requestId = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`mcp ${op} request timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try {
      win.webContents.send('mcp:request', { requestId, op, ...payload });
    } catch (e: any) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(new Error(e?.message || 'failed to reach renderer'));
    }
  });
}
