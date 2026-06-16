/**
 * TASK: aiChat — query → retrieved evidence (local + cloud) → STREAMED answer
 * from the chosen model.
 *
 * The conversational counterpart to initialProjectGenerate. Reuses the shared
 * `retrieve` fragment to "collect everything local + cloud", then `chatStream`
 * feeds the right model and streams the answer back:
 *   - cloud → Stella V2 WS (via ctx.cloudChat, injected by the entry hook)
 *   - local → llmAPI.streamMessage (shared worker; the StellaFullChat pattern)
 *   - claude-cli / codex → bridged streaming
 *
 * Input:  string (the user query) — also set on ctx.query by the entry point.
 *         ctx carries chatId / history / cloudChat for the chat surface.
 * Output: void (the answer streams via ctx.emit / the WS handler).
 */
import { recipe } from '../runner';
import { retrieve } from './retrieve';
import { filterRank } from '../steps/filterRank';
import { chatStream } from '../steps/chatStream';
import { MAX_CHAT_EVIDENCE } from '../steps/chatStreamWithSources';
import type { EvidenceItem, Step } from '../types';

// Cap the grounding set AFTER filterRank ordered it: the merged hybrid pool
// (multi-search top-24 + local fused + tag channel) can run 50+ items, which
// overflows the local model's ~4k context (empty answers) and bloats cloud's
// retrieved_context. filterRank puts the most relevant first; we feed the
// model the head.
const capEvidence: Step<EvidenceItem[], EvidenceItem[]> = async (evidence) =>
  (evidence ?? []).slice(0, MAX_CHAT_EVIDENCE);

export const aiChat: Step<string, void> = recipe<string, void>([
  retrieve as Step<unknown, unknown>,
  // The hybrid equalizer: local + cloud scores aren't comparable, so an LLM
  // (warm local worker; identity-cap on cloud/CLI) re-ranks the merged pile.
  filterRank as Step<unknown, unknown>,
  capEvidence as Step<unknown, unknown>,
  chatStream as Step<unknown, unknown>,
]);
