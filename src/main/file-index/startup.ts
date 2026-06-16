/**
 * File-index startup flow (main process):
 *   1. On macOS, check whether the app has Full Disk Access and, if not, prompt
 *      the user once with a button that deep-links the FDA settings pane. The
 *      app is non-sandboxed, so there's no programmatic grant — we can only
 *      open System Settings and ask the user to enable it (then relaunch).
 *   2. Auto-register the preset folders (Documents / Downloads) into the
 *      index so the sync loop has something to do.
 *
 * Probing reads a TCC-protected directory (`~/Library/Application Support/
 * com.apple.TCC`) — that read only succeeds when Full Disk Access is granted.
 */
import { app, dialog, shell } from 'electron';
import fsSync from 'fs';
import path from 'path';
import { autoRegisterPresets } from './sources';

/** True when the app can read TCC-protected locations (Documents/Downloads/…).
 *  Always true off macOS (no equivalent gate). */
export function hasFullDiskAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    fsSync.readdirSync(
      path.join(
        app.getPath('home'),
        'Library',
        'Application Support',
        'com.apple.TCC',
      ),
    );
    return true;
  } catch {
    return false;
  }
}

let fdaPrompted = false;

/** Prompt for Full Disk Access if we don't have it yet (once per launch). */
export async function promptFullDiskAccessIfNeeded(): Promise<void> {
  if (process.platform !== 'darwin' || fdaPrompted) return;
  if (hasFullDiskAccess()) return;
  fdaPrompted = true;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Open Settings', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Enable file indexing',
    message: 'Allow Constella to index your files',
    detail:
      'To search across your local files, grant Constella Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then restart the app.',
  });
  if (response === 0) {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    );
  }
}

/**
 * Run on app startup: request Full Disk Access if needed, then register the
 * preset folders. Both steps are best-effort — a missing grant just means the
 * presets fail to read until the user enables FDA, and self-heal next launch.
 */
export async function runFileIndexStartup(): Promise<void> {
  try {
    await promptFullDiskAccessIfNeeded();
  } catch {
    /* non-fatal */
  }
  try {
    await autoRegisterPresets();
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[file-index] auto-register failed:', e?.message ?? e);
  }
}
