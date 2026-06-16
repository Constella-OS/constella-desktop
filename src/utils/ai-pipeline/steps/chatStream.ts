/**
 * chatStream — the streaming synthesis tail for `aiChat`. Unlike synthesize
 * (one-shot structured), this STREAMS conversational tokens through whichever
 * model the user picked, emitting NormalizedEvents so the chat UI updates live.
 *
 * Provider dispatch (the "feed the right model" seam):
 *   - local → llmAPI.streamMessage(context) (the StellaFullChat pattern: IPC
 *     token stream off the shared worker) → emit text-delta per token.
 *   - claude-cli / codex → getBridgedProvider(id).run(...) → forward its
 *     NormalizedEvents verbatim (it already emits text-delta/tool-call/done).
 *   - cloud → ctx.cloudChat(...) (the Stella V2 WS, injected by the entry hook,
 *     because the WS lives in React). The retrieved local evidence is passed as
 *     graphContext so the cloud answer is grounded in local files too; the WS
 *     hook streams + renders via its own handler.
 *
 * Input: the merged EvidenceItem[] from `retrieve`. Output: void (it streams).
 */
import { llmAPI } from '../../api/llm-api';
import { getBridgedProvider } from '../../providers';
import type { EvidenceItem, Step } from '../types';

export const chatStream: Step<EvidenceItem[], void> = async (evidence, ctx) => {
  const query = ctx.query || '';

  // Cloud: delegate to the WS (injected). Pass local evidence as grounding.
  if (ctx.provider === 'cloud') {
    if (ctx.cloudChat && ctx.chatId) {
      await ctx.cloudChat({
        message: query,
        chatId: ctx.chatId,
        graphContext: { prompt_prefix: renderEvidence(evidence) },
      });
    } else {
      ctx.emit({ type: 'error', message: 'cloud chat unavailable (no WS bridge)' });
      ctx.emit({ type: 'done' });
    }
    return;
  }

  const context = buildChatContext(
    query,
    evidence,
    ctx.history,
    ctx.graphContext,
    !!INLINE_CITATIONS_BY_PROVIDER[ctx.provider],
  );

  // Local: stream tokens off the shared worker.
  if (ctx.provider === 'local') {
    try {
      const gen = await llmAPI.streamMessage(context);
      for await (const token of gen) {
        // Bail if a newer run superseded this one — applyNormalizedToChat is a
        // global sink, so a stale stream would otherwise corrupt the new chat.
        if (ctx.signal?.aborted) return;
        if (token.isComplete) break;
        if (token.text) ctx.emit({ type: 'text-delta', text: token.text });
      }
      ctx.emit({ type: 'done' });
    } catch (e: any) {
      ctx.emit({ type: 'error', message: e?.message || String(e) });
      ctx.emit({ type: 'done' });
    }
    return;
  }

  // claude-cli / codex: forward the bridged provider's NormalizedEvents. Pass
  // ctx.signal so a superseding run SIGTERMs this CLI child (bridgedProvider
  // wires abort → provider:cancel), and stop forwarding the moment it aborts so
  // this run's leftover tokens (incl. its cancellation 'done') never clobber the
  // new chat's streaming message.
  try {
    const provider = getBridgedProvider(ctx.provider);
    for await (const ev of provider.run(
      {
        providerId: ctx.provider,
        prompt: context,
        model: ctx.modelId,
        // claude-cli extended thinking — recall sets this high for Sonnet-4.6
        // follow-ups (fast haiku for the first answer, deeper thinking after).
        thinkingTokens: ctx.thinkingTokens,
        // CRITICAL for speed: the evidence + graph + history are already folded
        // into `prompt` (buildChatContext). Setting tools:false stops the CLI
        // from wiring the search MCP — otherwise claude re-runs search_notes
        // (round-trips to the backend, times out, and stalls the whole answer).
        tools: false,
      },
      ctx.signal,
    )) {
      if (ctx.signal?.aborted) return;
      ctx.emit(ev);
    }
  } catch (e: any) {
    ctx.emit({ type: 'error', message: e?.message || String(e) });
    ctx.emit({ type: 'done' });
  }
};

/**
 * Build the local/CLI prompt: recent history + the on-screen graph (canvas nodes
 * with content) + retrieved notes + the question. The graph context mirrors what
 * the cloud WS ships, so on-device answers are grounded in the same nodes.
 */
function buildChatContext(
  query: string,
  evidence: EvidenceItem[],
  history?: string,
  graphContext?: unknown,
  inlineCitations = false,
): string {
  let ctxText = '';
  if (history && history.trim()) {
    ctxText += `=== Previous Conversation ===\n\n${history.trim()}\n\n`;
  }
  const graph = renderGraphContext(graphContext);
  if (graph) {
    ctxText += `=== Current Graph (nodes on screen) ===\n\n${graph}\n\n`;
    // Tell the model the on-screen nodes are the user's PRIMARY focus. The
    // canvas is where they spatially arrange what they're actively thinking
    // about, so answers should connect/surface across those nodes first and
    // only reach beyond them (retrieved notes / own knowledge) when the
    // user's request genuinely needs information the canvas doesn't hold.
    ctxText += `${CANVAS_FOCUS_INSTRUCTION}\n\n`;
  }
  if (evidence.length) {
    ctxText += `=== Relevant Notes ===\n\n${renderEvidence(evidence)}\n\n`;
    // Composable: only ask for inline citations when this provider can do it.
    if (inlineCitations) {
      ctxText += `${INLINE_CITATION_INSTRUCTION}\n\n`;
    }
  }
  ctxText += `=== Current Message ===\n\n${query}`;
  return ctxText;
}

/** Render buildStructuredGraphContextPayload() output (graph_nodes + daily note)
 *  into prompt text — title + content per on-screen node. */
function renderGraphContext(gc: unknown): string {
  if (!gc || typeof gc !== 'object') return '';
  const g = gc as any;
  const nodes =
    g.graph_nodes && typeof g.graph_nodes === 'object'
      ? Object.values(g.graph_nodes)
      : [];
  const lines: string[] = [];
  for (const n of nodes as any[]) {
    const rd = n?.rxdbData;
    if (!rd) continue;
    const title = rd.title || rd.fileName || '(untitled)';
    const content = typeof rd.content === 'string' ? rd.content : '';
    lines.push(`Title: ${title}\n${content}`.slice(0, 600));
  }
  // Join sources by blank lines, NOT a markdown `---` rule: each line already
  // has a `Title:` prefix to delimit it, and a literal `---` in the prompt makes
  // the model mimic it as a horizontal-rule divider in its answer.
  let out = lines.join('\n\n');
  const daily = g.daily_note_data;
  if (daily && typeof daily === 'object' && typeof daily.content === 'string') {
    out += `\n\nDaily note:\n${daily.content}`.slice(0, 600);
  }
  return out;
}

// Canvas-focus framing for the local/CLI/codex prompt. Added right after the
// "Current Graph" section so the model treats the on-screen nodes as the user's
// primary context. "Use tools if necessary" maps here to the already-retrieved
// Relevant Notes + the model's own knowledge (the CLI runs tools:false for
// speed), so we point it at those rather than at a live search tool.
const CANVAS_FOCUS_INSTRUCTION = `=== Canvas Focus ===

The user is working on a project canvas. The "Current Graph (nodes on screen)"
above is what they have spatially arranged and are actively thinking about —
treat it as your PRIMARY focus. Ground your answer in those nodes first: connect
ideas across them, surface the threads that are emerging, and reference them
directly. Only reach beyond the canvas (the Relevant Notes below, or your own
knowledge) when the user's request genuinely needs information the canvas
doesn't contain — don't wander off the canvas for a question it already answers.`;

function renderEvidence(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) =>
      `[${e.uniqueid}] Title: ${e.title || '(untitled)'}\n${
        e.content || e.snippet || ''
      }`.slice(0, 800),
    )
    // Blank-line join, not `---`: the `[id] Title:` prefix delimits each item,
    // and a literal `---` makes the model echo horizontal-rule dividers.
    .join('\n\n');
}

// COMPOSABLE inline-citation instruction. The chat prompt is assembled from
// optional fragments (see buildChatContext) so we can drop this entirely for a
// provider that can't follow it — a small local model (Qwen3-4B) tends to emit
// malformed <source> tags or garble the text, whereas Claude/Codex handle it
// well. Flip a provider to false here to remove the instruction from its prompt.
export const INLINE_CITATIONS_BY_PROVIDER: Record<string, boolean> = {
  local: true, // ← set false if Qwen3 produces buggy/garbled inline citations
  'claude-cli': true,
  codex: true,
  cloud: false, // cloud answers stream from the backend (its own citation pills)
};

// The inline-citation fragment: tells the model to tag claims with the exact
// note ids shown in [brackets] in the evidence. The renderer (RecallChatPane)
// turns each <source id="…">label</source> into a teal chip next to the claim.
// Exported so the cloud home-discovery path (PostMindmapStellaTrigger) can
// append the SAME instruction to its retrieved_context.
export const INLINE_CITATION_INSTRUCTION = `=== Citations ===

When a sentence or bullet is supported by one of the Relevant Notes above, cite
it INLINE, immediately after that statement, by wrapping a 1–3 word label in:
<source id="THE_NOTE_ID">label</source>
Rules:
- Use ONLY the exact ids shown in [brackets] before each note. Never invent ids.
- Put the tag right after the specific claim it supports — not all at the end.
- Keep the label short (the note's topic). Cite at most one source per claim.`;
