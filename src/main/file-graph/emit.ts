/**
 * Stream generated graph records to the renderer (which owns RxDB). Mirrors
 * file-index/syncService.emit — lazy require of ../main avoids an import cycle.
 *   file-graph:records   → { notes: NoteRxdbData-shaped[] }   (bulkUpsert)
 *   file-graph:deletions → { ids: string[] }                  (soft-remove)
 */
export function emitGraph(channel: string, payload: any): void {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { mainWindow } = require('../main');
    mainWindow?.webContents?.send(channel, payload);
  } catch {
    /* window gone / not ready */
  }
}
