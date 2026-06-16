/**
 * Provider registry + platform gating.
 *
 * - Cloud (Stella) is available everywhere (web + desktop); its streaming is
 *   owned by useStellaV2WebSocket, so recall dispatches cloud through that hook
 *   (see useProviderRecall). Cloud is NOT a bridged async-iterable provider.
 * - Local (node-llama-cpp) and Claude Code CLI are desktop-only and run in the
 *   main process; they're exposed as bridged async-iterable Providers.
 *
 * On web, getPlatform().name === 'web' so only cloud is listed — the selector
 * silently offers cloud and never surfaces local/CLI.
 */
import { getPlatform } from '../../platform/platformInstance';
import { createBridgedProvider } from './bridgedProvider';
import type { Provider, ProviderId } from './types';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  cloud: 'Cloud Model',
  local: 'Local',
  'claude-cli': 'Claude Code',
  codex: 'Codex',
};

export const DEFAULT_PROVIDER: ProviderId = 'cloud';

/** True when a backend can run on the current platform (cheap, synchronous gate). */
export function isProviderEnabled(id: ProviderId): boolean {
  if (id === 'cloud') return true;
  let isDesktop = false;
  let localLLM = false;
  try {
    const p = getPlatform();
    isDesktop = p.name === 'desktop';
    localLLM = Boolean(p.capabilities?.localLLM);
  } catch {
    // getPlatform throws before bootstrap — treat as web/no-local.
    return false;
  }
  // CLI agents are desktop-only; availability of the actual binary is probed
  // separately (provider:detect) — this is just the cheap platform gate.
  if (id === 'claude-cli' || id === 'codex') return isDesktop;
  if (id === 'local') return isDesktop && localLLM;
  return false;
}

/** Providers to show in the selector, in display order, for this platform. */
export function listRecallProviders(): { id: ProviderId; label: string }[] {
  return (['cloud', 'local', 'claude-cli', 'codex'] as ProviderId[])
    .filter(isProviderEnabled)
    .map((id) => ({ id, label: PROVIDER_LABELS[id] }));
}

// Cache bridged providers so listeners/handles aren't rebuilt each call.
const bridged: Partial<Record<ProviderId, Provider>> = {};

/**
 * Get the bridged (main-process) Provider for local / claude-cli. Cloud has no
 * bridged provider — callers route cloud through the Stella WS hook instead.
 */
export function getBridgedProvider(
  id: 'local' | 'claude-cli' | 'codex',
): Provider {
  if (!bridged[id]) bridged[id] = createBridgedProvider(id, PROVIDER_LABELS[id]);
  return bridged[id] as Provider;
}
