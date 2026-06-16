/**
 * TASK: homeDiscoverySplit — the home-ask "split view" generator.
 *
 * ONE retrieve → ONE curation pass feeds BOTH tails, so the chat's source pills
 * and the canvas nodes are the EXACT same set:
 *   - selectNodes (curation)  → the curated relevant records. Drives the canvas
 *                               nodes AND the chat's grounding evidence + pills,
 *                               so they never diverge (previously pills were the
 *                               raw top-N by retrieval score while the canvas was
 *                               an LLM-curated subset — two different sets, and
 *                               the chat cited retrieval noise the canvas dropped).
 *   - classifyConnections     → the canvas edges (the slower pass).
 *   - chatStreamWithSources   → STREAMS the answer + source pills via ctx.emit.
 *
 * NODE-BEFORE-EDGE staging: we stage the NODES the instant selectNodes resolves
 * (ctx.onMindmap with empty edges) so they drain onto the canvas right away, then
 * deliver the edges via ctx.onMindmapEdges once classifyConnections finishes — the
 * map no longer waits for the edge pass before showing anything.
 *
 * PROVIDER ordering:
 *   - local shares ONE in-RAM LLM worker → run the chat and the edge pass
 *     SEQUENTIALLY (chat first — it's what the user reads).
 *   - claude-cli / codex spawn INDEPENDENT processes → run the edge pass and the
 *     chat answer CONCURRENTLY so the chat's first token isn't gated by edges.
 *   - cloud never reaches this recipe (start-home-discovery early-returns to the
 *     SSE path); we keep a safe fallback to the monolithic buildMindmap anyway.
 *
 * Used ONLY for the initial home-ask submit. Follow-up chat turns in the same
 * split reuse the existing `aiChat` recipe (no mindmap rebuild) — see
 * useProviderRecall / RecallChatDock.
 *
 * Input:  string (the user query, also set on ctx.query by the entry point).
 * Output: MindmapResult (nodes + edges) for the canvas.
 */
import { retrieve } from './retrieve';
import {
  buildMindmap,
  selectNodes,
  classifyConnections,
} from '../steps/buildMindmap';
import { chatStreamWithSources } from '../steps/chatStreamWithSources';
import type { MindmapResult, Step } from '../types';

export const homeDiscoverySplit: Step<string, MindmapResult> = async (
  query,
  ctx,
) => {
  const evidence = await retrieve(query, ctx); // ONE retrieve feeds the curation

  // Cloud never lands here (it took the SSE early-return). Stay safe: fall back
  // to the monolithic server-side mindmap, but deliver it through the SAME
  // node-then-edges staging shape (nodes via onMindmap with empty edges, edges
  // via onMindmapEdges) so the caller's staging path is uniform across providers.
  if (ctx.provider === 'cloud') {
    const mindmap = await buildMindmap(evidence, ctx);
    ctx.onMindmap?.({ nodes: mindmap.nodes, edges: [] });
    ctx.onMindmapEdges?.(mindmap.edges ?? []);
    await chatStreamWithSources(evidence, ctx);
    return mindmap;
  }

  // ONE curation pass. `selected` is the single source of truth for BOTH tails,
  // ordered by retrieval rank (so chatStreamWithSources' top-N pill/answer slices
  // stay meaningful). This is why the chat pills now match the canvas nodes and
  // the chat stops citing the noise the curation dropped.
  const selected = await selectNodes(query, evidence, ctx);
  const nodes = selected.map((e) => e.raw).filter(Boolean);

  // Stage the NODES immediately (edges still being classified) so the canvas
  // populates ~one LLM call sooner. Edges arrive via onMindmapEdges below.
  ctx.onMindmap?.({ nodes, edges: [] });

  // Classify edges, then ALWAYS report them via onMindmapEdges — even on an
  // empty result or a failure — so the caller's "edges final" signal flips and
  // the canvas never hangs waiting for edges that aren't coming.
  const classify = async () => {
    try {
      return await classifyConnections(query, selected, ctx);
    } catch (err) {
      console.warn('[ai-pipeline] classifyConnections failed:', err);
      return [];
    }
  };

  if (ctx.provider === 'local') {
    // Shared worker — one generation at a time. Chat first (the user reads it),
    // then classify edges and stream them in after.
    await chatStreamWithSources(selected, ctx);
    const edges = await classify();
    ctx.onMindmapEdges?.(edges);
    return { nodes, edges };
  }

  // claude-cli / codex: independent processes → edges + chat run CONCURRENTLY.
  const [edges] = await Promise.all([
    classify().then((e) => {
      ctx.onMindmapEdges?.(e);
      return e;
    }),
    chatStreamWithSources(selected, ctx),
  ]);
  return { nodes, edges };
};
