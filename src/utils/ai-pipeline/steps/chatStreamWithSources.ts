/**
 * chatStreamWithSources — the chat tail for the home-discovery split view.
 *
 * Same streaming synthesis as `chatStream`, but FIRST emits a `sources` event
 * built directly from the shared retrieved evidence, so the chat's source pills
 * are exactly the same set the mindmap canvas is built from. This is what makes
 * the split view's "chat sources == canvas nodes" guarantee hold for local/cli.
 *
 * Cloud caveat: on cloud the answer streams via the Stella V2 WS (ctx.cloudChat),
 * which attaches its OWN retrievals_used sources, and the canvas mindmap is built
 * server-side from a separate retrieval — so we skip the manual emit on cloud to
 * avoid double pills, and the "same set" guarantee is best-effort there.
 *
 * Input:  the merged EvidenceItem[] from `retrieve` (shared with buildMindmap).
 * Output: void (the answer streams via ctx.emit / the WS handler).
 */
import { chatStream } from './chatStream';
import type { Citation } from '../../providers/types';
import type { EvidenceItem, Step } from '../types';

// How many evidence items become source pills under the answer. Mirrors the
// node cap so the pills track the canvas without overflowing the chat header.
const MAX_SOURCE_PILLS = 12;

// How many evidence items are fed into the ANSWER prompt. The local model's
// context is only ~4096 tokens (llm.ts), and the mindmap step can select 15–24
// nodes — feeding all of them into the chat prompt overflows the window and the
// local generation comes back EMPTY. Cap the grounding evidence so the prompt
// always fits; the full set still shows as source pills above. (Cloud has a far
// larger window, but a tight, relevant grounding set is good there too.)
// Exported: aiChat (follow-up turns) applies the same cap after filterRank.
export const MAX_CHAT_EVIDENCE = 8;

export const chatStreamWithSources: Step<EvidenceItem[], void> = async (
  evidence,
  ctx,
) => {
  // Local / CLI: the answer streams through ctx.emit and the evidence we just
  // retrieved IS the canvas node set — surface it as citation pills up front so
  // the chat shows its sources the moment the answer starts. Cloud gets its
  // pills from the WS's own retrievals_used frame, so don't double-emit there.
  if (ctx.provider !== 'cloud' && evidence.length) {
    const citations: Citation[] = evidence
      .slice(0, MAX_SOURCE_PILLS)
      .map((e) => ({
        uniqueid: e.uniqueid,
        title: e.title,
        integration: e.integration,
        excerpt: e.snippet,
        raw: e.raw,
      }));
    ctx.emit({ type: 'sources', citations });
  }

  // Reuse the existing provider dispatch (local stream / cli bridge / cloud WS),
  // but only with the top-N evidence so the local model's context window doesn't
  // overflow (which silently yields an empty answer). The full set was already
  // emitted as source pills above.
  await chatStream(evidence.slice(0, MAX_CHAT_EVIDENCE), ctx);
};
