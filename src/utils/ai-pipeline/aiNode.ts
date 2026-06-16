/**
 * AI Node pipeline operations — the three phases of the AI-Node "my knowledge"
 * feature, each routed through the provider so local / claude-cli / codex work
 * alongside cloud. Every function returns the EXACT shape the existing AINode /
 * AIChatOutputNode UI already consumes, so wiring is a drop-in:
 *
 *   aiNodeSearch        → AISearchResult     (the CREATE phase / fetchAISearch)
 *   aiNodeSynthesize    → AISynthesizeResult (the Synthesize button / fetchAISynthesize)
 *   aiNodeCustomPrompt  → AISynthesizeResult (custom prompt — synthesize w/ the user's prompt)
 *
 * Provider dispatch:
 *   - cloud → delegate to the existing fetch* (identical behavior, zero regression)
 *   - local / cli → our retrieve (local+cloud, hydrated) → on-device synthesis,
 *     mapped into the same result shape.
 */
import { v4 as uuidv4 } from 'uuid';

import {
  fetchAISearch,
  fetchAISynthesize,
  fetchAIChat,
  type AISource,
  type AISearchResult,
  type AISynthesizeResult,
  type AISynthesizeSourceRef,
} from '../retrieval/ai-search';
import type { RelevantNote } from '../../models/RelevantNote';
import { retrieve } from './recipes/retrieve';
import { runModelOnce } from './binding/runModel';
import { buildStructuredPrompt } from './binding/structuredPrompt';
import { parseJsonObject } from './binding/jsonExtract';
import { recallInsightsSchema } from './schemas/recallInsights.schema';
import type { EvidenceItem, StepCtx } from './types';

// ---- Phase 1: SEARCH (AINode create) → AISearchResult ---------------------

export async function aiNodeSearch(
  query: string,
  ctx: StepCtx,
): Promise<AISearchResult> {
  if (ctx.provider === 'cloud') {
    // Exact existing behavior: backend retrieval + rich expandedNotes + run id.
    return fetchAISearch({
      query,
      userId: ctx.userId,
      accessToken: ctx.accessToken || '',
      signal: ctx.signal,
    });
  }

  // local / cli: our hybrid retrieve (LanceDB-hydrated + cloud), formatted to
  // the AISearchResult shape. A synthetic runId lets the Synthesize/Chat
  // affordances work via the attached_sources fallback (no backend run exists).
  const evidence = await retrieve(query, ctx);
  return {
    title: `Found ${evidence.length} sources for: ${query}`,
    keyInsights: '',
    sources: evidence.map(evidenceToSource),
    expandedNotes: evidence
      .map((e) => e.raw)
      .filter((n): n is RelevantNote => Boolean(n)),
    runId: uuidv4(),
  };
}

// ---- Phase 2: SYNTHESIZE (button) → AISynthesizeResult --------------------

export interface AiNodeSynthesizeArgs {
  query: string;
  runId: string;
  /** Parent node's persisted sources (slim refs) — used for the cloud fallback. */
  sources?: AISynthesizeSourceRef[];
}

export async function aiNodeSynthesize(
  args: AiNodeSynthesizeArgs,
  ctx: StepCtx,
): Promise<AISynthesizeResult> {
  if (ctx.provider === 'cloud') {
    return fetchAISynthesize({
      runId: args.runId,
      userId: ctx.userId,
      accessToken: ctx.accessToken || '',
      attachedSources: args.sources,
      query: args.query,
      signal: ctx.signal,
    });
  }

  // local / cli: re-retrieve (to get hydrated content the slim refs lack), then
  // synthesize on-device and map to AISynthesizeResult.
  const evidence = await retrieve(args.query, ctx);
  const obj = await localSynthesize(args.query, evidence, ctx);
  return insightsToSynthesizeResult(args.query, obj, evidence);
}

// ---- Phase 3: CUSTOM PROMPT → AISynthesizeResult --------------------------

export interface AiNodeCustomPromptArgs {
  query: string;
  customPrompt: string;
  runId: string;
  sources?: AISynthesizeSourceRef[];
}

export async function aiNodeCustomPrompt(
  args: AiNodeCustomPromptArgs,
  ctx: StepCtx,
): Promise<AISynthesizeResult> {
  if (ctx.provider === 'cloud') {
    // No cloud endpoint takes a custom synthesis prompt; ai-chat answers the
    // custom prompt against the run, and we wrap its text into the synthesize
    // shape so the UI renders consistently.
    const chat = await fetchAIChat({
      runId: args.runId,
      userId: ctx.userId,
      message: args.customPrompt,
      chatHistory: [],
      accessToken: ctx.accessToken || '',
      signal: ctx.signal,
    });
    return {
      title: args.customPrompt.slice(0, 80),
      keyInsights: chat.response || '',
      sourceLinks: [],
      themes: [],
      attachedSources: [],
      sourcesSummary: '',
    };
  }

  // local / cli: synthesize over re-retrieved evidence using the user's prompt
  // as the instruction.
  const evidence = await retrieve(args.query, ctx);
  const obj = await localSynthesize(args.query, evidence, ctx, args.customPrompt);
  return insightsToSynthesizeResult(args.customPrompt, obj, evidence);
}

// ---- shared helpers -------------------------------------------------------

/** Run on-device structured synthesis over evidence; returns the recallInsights
 *  object ({title, key_insights[], source_ids}) or null. `instruction` overrides
 *  the default "answer the query" directive (used by custom prompt). */
async function localSynthesize(
  query: string,
  evidence: EvidenceItem[],
  ctx: StepCtx,
  instruction?: string,
): Promise<Record<string, unknown> | null> {
  const directive =
    instruction?.trim() ||
    'Answer the query using ONLY the evidence above. Cite the uniqueids you used.';
  const base = `Query: ${query}

Evidence (each tagged with its uniqueid):
${evidence
  .map((e) =>
    `[${e.uniqueid}] ${e.title || '(untitled)'}\n${
      e.content || e.snippet || ''
    }`.slice(0, 800),
  )
  .join('\n\n')}

${directive}`;
  const text = await runModelOnce(
    ctx,
    buildStructuredPrompt(base, recallInsightsSchema),
  );
  return text ? parseJsonObject<Record<string, unknown>>(text) : null;
}

const isStr = (x: unknown): x is string => typeof x === 'string' && !!x;

/** Map an EvidenceItem → the slim AISource the AINode pills + canvas expect. */
function evidenceToSource(e: EvidenceItem): AISource {
  return {
    id: e.uniqueid,
    title: e.title || '',
    sourceUrl: '',
    integrationName: e.integration || (e.origin === 'local' ? 'local' : ''),
    note: (e.raw as RelevantNote) ?? undefined,
    summary: e.snippet,
    contentPreview: e.content,
  };
}

/** Map the on-device recallInsights object → AISynthesizeResult. */
function insightsToSynthesizeResult(
  query: string,
  obj: Record<string, unknown> | null,
  evidence: EvidenceItem[],
): AISynthesizeResult {
  const insights = Array.isArray(obj?.key_insights)
    ? (obj!.key_insights as unknown[]).filter(isStr)
    : [];
  const sourceIds = Array.isArray(obj?.source_ids)
    ? (obj!.source_ids as unknown[]).filter(isStr)
    : [];
  const keyInsights = insights.map((b) => `- ${b}`).join('\n');
  const title = isStr(obj?.title) ? (obj!.title as string) : `Synthesis for: ${query}`;

  return {
    title,
    keyInsights: keyInsights || 'No synthesis produced.',
    sourceLinks: sourceIds.length ? [{ insightIdx: 0, sourceIds }] : [],
    themes: [],
    attachedSources: evidence.slice(0, 20).map((e) => ({
      id: e.uniqueid,
      kind: e.origin === 'local' ? 'file' : 'note',
      title: e.title || '',
      meta: e.integration || '',
      source_url: undefined,
      integration_name: e.integration,
      summary: e.snippet,
    })),
    sourcesSummary: '',
  };
}
