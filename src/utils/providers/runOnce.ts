/**
 * One-shot text collector — the seam the background synthesis engine (#5) will
 * call instead of streaming into a chat. Cloud is decided server-side and not
 * supported here from the renderer; local / claude-cli run via the main process.
 *
 * For main-process callers (the synthesis scheduler), prefer runOnceMain in
 * src/main/providers/runner.ts directly. This renderer helper just proxies the
 * IPC handler for symmetry / debugging.
 */
import {
  PROVIDER_IPC,
  type ProviderRequest,
  type RunOnceResult,
} from './types';

export async function runOnce(req: ProviderRequest): Promise<RunOnceResult> {
  const bridge = (window as any).electron?.ipcRenderer;
  if (!bridge) return { text: '', ok: false, error: 'IPC bridge unavailable' };
  try {
    return await bridge.invoke(PROVIDER_IPC.runOnce, req);
  } catch (e: any) {
    return { text: '', ok: false, error: e?.message || String(e) };
  }
}
