/**
 * LLM access for the knowledge-graph engine.
 *
 *  - `extractJson` — tolerant JSON extraction (ported from agents-slack
 *    wiki/llm.ts) since no provider here guarantees a JSON-only response.
 *  - `runGraphLLM` — recall-first wrapper: it waits until the user isn't using
 *    the shared local worker for Recall/chat, then runs a one-shot prompt via
 *    `runOnceMain` on the resolved provider, and parses the JSON.
 */
import { runOnceMain, isRecallActive } from '../providers/runner';
import { resolveGraphProvider } from './provider';
import type { GraphProvider } from './provider';
import { RECALL_COOLDOWN_MS } from './constants';
import { getUserContextPreamble } from '../userContext';

/** Prepend the onboarding "who the user is" preamble to a system prompt so the
 *  graph engine's connections + concept/theme synthesis reflect the user's
 *  domain. Returns the prompt unchanged when no context was collected. */
function withUserContext(systemPrompt: string): string {
  const preamble = getUserContextPreamble();
  return preamble ? `${preamble}\n\n${systemPrompt}` : systemPrompt;
}

/** Parse the first balanced JSON object out of a (possibly prose-wrapped) reply. */
export function extractJson(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* try harder */
  }
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Resolve once the shared worker is idle of interactive Recall (recall-first). */
async function waitForIdle(maxWaitMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (isRecallActive(RECALL_COOLDOWN_MS)) {
    if (Date.now() - start > maxWaitMs) return false; // give up this tick
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

export interface GraphLLMResult {
  json: any | null;
  ok: boolean;
  raw: string;
  error?: string;
  providerId?: GraphProvider;
}

/** What the engine is doing with this call — the backend's cloud proxy gates
 *  each purpose against the user's monthly AI quota (connections / insights /
 *  themes) and meters one billable unit per classify/concept/theme. */
export type GraphLLMPurpose =
  | 'connection_query'
  | 'connection_classify'
  | 'concept'
  | 'theme';

/** One-shot system+user prompt → parsed JSON, recall-gated and provider-routed. */
export async function runGraphLLM(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 120_000,
  purpose: GraphLLMPurpose = 'connection_query',
): Promise<GraphLLMResult> {
  const idle = await waitForIdle();
  if (!idle) {
    return { json: null, ok: false, raw: '', error: 'recall-active; deferred' };
  }
  // Personalize every graph prompt (query / classify / concept / theme) with
  // the user's onboarding context. runOnceMain is called with background:true
  // below, so providers/runner deliberately skips its own injection — no double
  // preamble on the CLI route; the cloud route gets it via system_prompt here.
  const sys = withUserContext(systemPrompt);
  const providerId = await resolveGraphProvider();
  if (!providerId) {
    // No provider configured/installed → skip connections (indexing still
    // runs). The scheduler's availability gate normally stops us before here;
    // this is the belt-and-suspenders guard so we never fall back to local.
    return {
      json: null,
      ok: false,
      raw: '',
      error: 'no graph provider (CLI or cloud); connections skipped',
    };
  }
  // Cloud pick: route the one-shot prompt through the backend proxy — same
  // prompts, same JSON parsing, same throttles; only the model runs remotely
  // (on the backend's cheap connection-model fallback chain).
  if (providerId === 'cloud') {
    // Monthly AI quota already known-exhausted → don't burn the HTTP call.
    // The suppression window expires on its own; the next call re-probes.
    const { cloudQuotaExceeded, markCloudQuotaExceeded } =
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      require('./cloudQuota');
    if (cloudQuotaExceeded()) {
      return {
        json: null,
        ok: false,
        raw: '',
        error: 'cloud AI quota exhausted; connections paused',
        providerId,
      };
    }
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const axios = require('axios').default ?? require('axios');
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { BACKEND_URL } = require('../constants');
      const resp = await axios.post(
        `${BACKEND_URL}constella_db/graph_llm`,
        // max_tokens at the endpoint's ceiling: concept/theme synthesis
        // returns full markdown pages inside the JSON — the 2000-token
        // endpoint default could truncate mid-object (unbalanced braces →
        // extractJson null → page silently skipped). CLI runs have no cap.
        {
          system_prompt: sys,
          prompt: userPrompt,
          max_tokens: 4000,
          purpose,
        },
        { timeout: timeoutMs },
      );
      const text: string = resp.data?.text ?? '';
      if (!text) {
        return {
          json: null,
          ok: false,
          raw: '',
          error: 'cloud graph LLM returned empty',
          providerId,
        };
      }
      return { json: extractJson(text), ok: true, raw: text, providerId };
    } catch (e: any) {
      // 429 = monthly quota exhausted for the user's tier — arm the home
      // banner ("upgrade or use your own AI") and suppress further calls.
      if (e?.response?.status === 429) {
        const detail = e?.response?.data?.detail ?? {};
        const tier = detail?.tier ?? '';
        const used = detail?.used;
        const limit = detail?.limit;
        const usage =
          typeof used === 'number' && typeof limit === 'number'
            ? `, used=${used}/${limit}`
            : '';
        markCloudQuotaExceeded(tier);
        return {
          json: null,
          ok: false,
          raw: '',
          error: `cloud AI quota exhausted (tier=${tier || 'unknown'}${usage})`,
          providerId,
        };
      }
      // Include e.code: a refused/timed-out connection (ECONNREFUSED,
      // ETIMEDOUT) often has an EMPTY axios message, so `e?.message` alone
      // logs a blank reason — the code is what tells you it's a network
      // failure (e.g. backend down / wrong host) vs a real LLM error.
      return {
        json: null,
        ok: false,
        raw: '',
        error: `cloud graph LLM failed: ${e?.message || e?.code || e}`,
        providerId,
      };
    }
  }
  const r = await runOnceMain({
    providerId,
    prompt: userPrompt,
    systemPrompt: sys,
    timeoutMs,
    // Background/lightweight: haiku + no MCP, so the connection/synth engine
    // stays cheap and never contends with the user's interactive recall.
    background: true,
  });
  if (!r.ok) {
    return {
      json: null,
      ok: false,
      raw: r.text || '',
      error: r.error,
      providerId,
    };
  }
  return { json: extractJson(r.text), ok: true, raw: r.text, providerId };
}

/** Tell the backend how many cloud-generated graph edges were actually saved.
 *  Called only after local edge persistence succeeds, so failed LLM calls,
 *  malformed JSON, and all-filtered classifications do not spend quota. */
export async function recordCloudGraphConnectionsUsage(
  count: number,
): Promise<void> {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount <= 0) return;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const axios = require('axios').default ?? require('axios');
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { BACKEND_URL } = require('../constants');
    await axios.post(
      `${BACKEND_URL}constella_db/graph_llm_usage`,
      {
        purpose: 'connection_edges',
        count: safeCount,
      },
      { timeout: 15_000 },
    );
  } catch (e: any) {
    console.warn(
      `[file-graph:usage] failed to meter ${safeCount} cloud edge(s): ${
        e?.message || e?.code || e
      }`,
    );
  }
}
