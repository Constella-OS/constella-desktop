/**
 * Resolve which LLM provider the background knowledge-graph engine should use.
 *
 * The user's interactive provider choice (`selectedProvider`) lives in the
 * renderer's localStorage, so the renderer write-throughs it to electron-store
 * key `graph.provider` (see SearchStore.setSelectedProvider + the
 * `file-graph:set-provider` IPC). Main reads it here. A 'cloud' pick routes
 * the engine's LLM steps through the backend proxy endpoint (graph_llm); CLI
 * picks run claude/codex; 'local' never runs connections (it would thrash the
 * embedder out of RAM) and falls back across whatever CLI is installed.
 */
import { getStoreValue, setStoreValue } from '../utils/storage/store';
import {
  detectClaudeBinary,
  detectCodexBinary,
} from '../providers/agentRunner';
import type { ProviderId } from '../../utils/providers/types';

export const GRAPH_PROVIDER_KEY = 'graph.provider';

export type GraphProvider = 'local' | 'claude-cli' | 'codex' | 'cloud';

/**
 * Cloud graph branch: when the user's provider pick is 'cloud', the engine's
 * LLM steps (query gen, classification, synthesis) route through the backend
 * proxy (POST /constella_db/graph_llm) — retrieval, prompts, throttles, and
 * edge storage all stay local. Available whenever main's axios is signed in
 * (the same access-token the integration relay uses).
 */
function cloudGraphAvailable(): boolean {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const axios = require('axios').default ?? require('axios');
    return Boolean(axios.defaults.headers.common['access-token']);
  } catch {
    return false;
  }
}

/** Persist the renderer's provider choice for the main-side engine to read. */
export async function setGraphProvider(p: ProviderId): Promise<void> {
  try {
    await setStoreValue(GRAPH_PROVIDER_KEY, p);
  } catch {
    /* non-fatal */
  }
}

/**
 * CLI providers that are actually installed right now. CONNECTIONS are CLI-only
 * by design: the local LLM is intentionally excluded because it thrashes the
 * embedder out of RAM. Indexing still uses the local embedder — this is only
 * about whether the *connection* engine runs. Order = claude-cli first.
 */
function availableCliProviders(): GraphProvider[] {
  const out: GraphProvider[] = [];
  if (detectClaudeBinary() != null) out.push('claude-cli');
  if (detectCodexBinary() != null) out.push('codex');
  return out;
}

/**
 * Resolve the provider for a background connection run. A signed-in 'cloud'
 * pick routes to the backend LLM proxy; CLI picks honor the user's choice then
 * fall back to the OTHER CLI. Returns null when nothing is available — the
 * caller then SKIPS connections entirely; indexing is unaffected. Local is
 * never used for connections (it thrashes the embedder out of RAM).
 */
export async function resolveGraphProvider(): Promise<GraphProvider | null> {
  let pref = '';
  try {
    pref = ((await getStoreValue(GRAPH_PROVIDER_KEY, '')) as string) || '';
  } catch {
    /* default below */
  }
  // Explicit cloud pick → backend LLM proxy (when signed in). This is the
  // user's own provider choice, so routing the graph's LLM steps to the cloud
  // is opted-in, not a silent fallback. CLIs still win for local/unset picks,
  // and a cloud pick on a signed-OUT app falls through to any installed CLI.
  if (pref === 'cloud' && cloudGraphAvailable()) return 'cloud';
  const avail = availableCliProviders();
  if (avail.length === 0) return null;
  // The user's CLI pick first, else the other CLI (claude-cli preferred when
  // the pick is local/unset). Always falls back to whatever is installed.
  const order: GraphProvider[] =
    pref === 'codex' ? ['codex', 'claude-cli'] : ['claude-cli', 'codex'];
  for (const p of order) if (avail.includes(p)) return p;
  return avail[0];
}

/**
 * True when SOME backend exists to run connections: an installed CLI, or the
 * cloud proxy when the user's pick is 'cloud' and the app is signed in. When
 * false, the engine SKIPS connections (concepts/themes/edges) and only
 * indexing runs — per the "if neither is set / not configured, just index
 * without connections" rule.
 */
export async function graphProviderAvailable(): Promise<boolean> {
  if (availableCliProviders().length > 0) return true;
  try {
    const pref = ((await getStoreValue(GRAPH_PROVIDER_KEY, '')) as string) || '';
    return pref === 'cloud' && cloudGraphAvailable();
  } catch {
    return false;
  }
}
