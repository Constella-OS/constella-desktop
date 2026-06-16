/**
 * prewarmProvider — fire-and-forget: ask the main process to spawn a claude-cli
 * child NOW (on new-chat) so its ~1s spawn/load overlaps retrieval. The next
 * matching `provider:run` feeds it the prompt instead of spawning fresh.
 *
 * Only meaningful for claude-cli (the only subprocess provider with a real
 * cold-start); the main handler no-ops for anything else. Safe on web / when
 * the IPC bridge is absent. Pass the SAME model/thinkingTokens the upcoming run
 * will use (from recallModelFor) so the warm child's args match and it's reused.
 */
import { PROVIDER_IPC, type ProviderId } from './types';

export function prewarmProvider(req: {
  providerId: ProviderId;
  model?: string;
  thinkingTokens?: number;
}): void {
  if (req.providerId !== 'claude-cli') return;
  try {
    const bridge = (window as any)?.electron?.ipcRenderer;
    bridge?.invoke?.(PROVIDER_IPC.prewarm, req)?.catch?.(() => undefined);
  } catch {
    /* web build / no electron — pre-warm is a desktop-only optimization */
  }
}
