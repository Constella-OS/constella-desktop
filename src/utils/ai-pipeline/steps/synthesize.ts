/**
 * synthesize — model-bound step: turn ranked evidence into the task's structured
 * output (for recall: {title, key_insights, source_ids}) AND stream the same
 * NormalizedEvents the cloud emits, so applyNormalizedToChat renders it identically.
 *
 * Schema binding by provider kind (see README "one schema, three bindings"):
 *   - local / claude-cli / codex → strict structured prompt + balanced-brace
 *     extractor (this file). (Local Qwen will additionally get a GBNF grammar in
 *     the worker; the prompt is harmless there.)
 *   - cloud → not wired from the renderer yet; the cloud recall answer streams
 *     over the Stella V2 WS in useProviderRecall. Here it emits a meta note and
 *     returns null so the recipe completes cleanly.
 *
 * Built via a factory so the schema is bound at recipe-assembly time; the query +
 * evidence arrive at run time (query via ctx.query, evidence as the step input).
 */
import { runModelOnce } from '../binding/runModel';
import { buildStructuredPrompt } from '../binding/structuredPrompt';
import { parseJsonObject } from '../binding/jsonExtract';
import type { Citation } from '../../providers/types';
import type { EvidenceItem, PipelineSchema, Step } from '../types';

/** Bind a synthesize Step to a specific output schema (e.g. recallInsights). */
export function makeSynthesize(
  schema: PipelineSchema,
): Step<EvidenceItem[], Record<string, unknown> | null> {
  return async (evidence, ctx) => {
    const query = ctx.query || '';

    // Cloud: handled by the WS path elsewhere; nothing to synthesize here.
    if (ctx.provider === 'cloud') {
      ctx.emit({
        type: 'meta',
        message: 'cloud synthesize routes via Stella WS (not the pipeline)',
      });
      ctx.emit({ type: 'done' });
      return null;
    }

    const base = `Query: ${query}

Evidence (each tagged with its uniqueid):
${renderEvidence(evidence)}

Answer the query using ONLY the evidence above. Cite the uniqueids you used.`;

    const text = await runModelOnce(ctx, buildStructuredPrompt(base, schema));
    const obj = text ? parseJsonObject<Record<string, unknown>>(text) : null;

    if (!obj) {
      // One more chance is the model's job; here we surface what we got as text.
      ctx.emit({ type: 'text', text: text || 'No answer produced.' });
      ctx.emit({ type: 'done', finalText: text || undefined });
      return null;
    }

    // Stream the structured result as the same frames the cloud emits.
    emitSynthesis(ctx.emit, obj, evidence);
    return obj;
  };
}

/** Render evidence compactly for the synthesis prompt. */
function renderEvidence(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) =>
      `[${e.uniqueid}] ${e.title || '(untitled)'}\n${e.snippet || ''}`.slice(
        0,
        800,
      ),
    )
    .join('\n\n');
}

/** Map a structured recall result → sources pills + answer text + done. */
function emitSynthesis(
  emit: (e: import('../types').NormalizedEvent) => void,
  obj: Record<string, unknown>,
  evidence: EvidenceItem[],
): void {
  const sourceIds = Array.isArray(obj.source_ids)
    ? (obj.source_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (sourceIds.length) {
    const byId = new Map(evidence.map((e) => [e.uniqueid, e]));
    const citations: Citation[] = sourceIds
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceItem => Boolean(e))
      .map((e) => ({
        uniqueid: e.uniqueid,
        title: e.title,
        integration: e.integration,
        excerpt: e.snippet,
        raw: e.raw,
      }));
    if (citations.length) emit({ type: 'sources', citations });
  }

  const title = typeof obj.title === 'string' ? obj.title : '';
  const insights = Array.isArray(obj.key_insights)
    ? (obj.key_insights as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const answer = [title, ...insights.map((b) => `• ${b}`)]
    .filter(Boolean)
    .join('\n');

  emit({ type: 'text', text: answer || 'No answer produced.' });
  emit({ type: 'done', finalText: answer || undefined });
}
