/**
 * synthesizeInsights — the synthesis tail for `aiSearch` (the AI-Node "my
 * knowledge" shape). Produces {title, key_insights, source_ids} and streams the
 * same NormalizedEvents (sources pills + answer + done) so it renders via
 * applyNormalizedToChat.
 *
 * Provider dispatch — all three synthesize over the SAME merged local+cloud bundle:
 *   - cloud → POST /search/ai-synthesize with a SYNTHETIC run_id (forces the
 *     "no stored run → use attached_sources" fallback) + the merged evidence as
 *     attached_sources. Because parents_from_source_refs uses the `content` we
 *     ship, local-only files reach the cloud synthesis too (no new endpoint).
 *   - local → on-device worker (GBNF) over the merged evidence.
 *   - claude-cli / codex → strict-prompt + brace-extractor over the merged evidence.
 */
import { v4 as uuidv4 } from 'uuid';

import { fetchAISynthesize } from '../../retrieval/ai-search';
import { runModelOnce } from '../binding/runModel';
import { buildStructuredPrompt } from '../binding/structuredPrompt';
import { parseJsonObject } from '../binding/jsonExtract';
import { recallInsightsSchema } from '../schemas/recallInsights.schema';
import type { Citation } from '../../providers/types';
import type { EvidenceItem, NormalizedEvent, Step } from '../types';

export const synthesizeInsights: Step<EvidenceItem[], unknown> = async (
  evidence,
  ctx,
) => {
  const query = ctx.query || '';

  // ---- Cloud: /search/ai-synthesize with our merged evidence as attached_sources.
  if (ctx.provider === 'cloud') {
    if (!ctx.accessToken || !ctx.userId) {
      ctx.emit({ type: 'meta', message: 'cloud synthesize unavailable (no auth)' });
      ctx.emit({ type: 'done' });
      return null;
    }
    try {
      const res: any = await fetchAISynthesize({
        runId: uuidv4(), // synthetic → forces the attached_sources fallback path
        userId: ctx.userId,
        accessToken: ctx.accessToken,
        query,
        attachedSources: evidence.slice(0, 20).map((e) => ({
          id: e.uniqueid,
          title: e.title,
          integration_name: e.integration,
          summary: e.snippet,
          content: e.content ?? e.snippet,
          source_type: e.origin === 'local' ? 'file' : undefined,
        })),
        signal: ctx.signal,
      });
      emitCloud(ctx.emit, res, evidence);
      return res;
    } catch (e: any) {
      ctx.emit({ type: 'error', message: e?.message || String(e) });
      ctx.emit({ type: 'done' });
      return null;
    }
  }

  // ---- Local / CLI: synthesize on-device over the merged evidence.
  const base = `Query: ${query}

Evidence (each tagged with its uniqueid):
${renderEvidence(evidence)}

Answer the query using ONLY the evidence above. Cite the uniqueids you used.`;

  const text = await runModelOnce(
    ctx,
    buildStructuredPrompt(base, recallInsightsSchema),
  );
  const obj = text ? parseJsonObject<Record<string, unknown>>(text) : null;
  if (!obj) {
    ctx.emit({ type: 'text', text: text || 'No answer produced.' });
    ctx.emit({ type: 'done', finalText: text || undefined });
    return null;
  }
  emitStructured(ctx.emit, obj, evidence);
  return obj;
};

// ---- helpers --------------------------------------------------------------

function renderEvidence(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) =>
      `[${e.uniqueid}] ${e.title || '(untitled)'}\n${
        e.content || e.snippet || ''
      }`.slice(0, 800),
    )
    .join('\n\n');
}

const isStr = (x: unknown): x is string => typeof x === 'string' && !!x;

/** Emit source pills for the given ids (mapped from the evidence we have). */
function emitSources(
  emit: (e: NormalizedEvent) => void,
  ids: string[],
  evidence: EvidenceItem[],
): void {
  if (!ids.length) return;
  const byId = new Map(evidence.map((e) => [e.uniqueid, e]));
  const citations: Citation[] = ids
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

/** Local/CLI structured object: {title, key_insights[], source_ids?}. */
function emitStructured(
  emit: (e: NormalizedEvent) => void,
  obj: Record<string, unknown>,
  evidence: EvidenceItem[],
): void {
  const sourceIds = Array.isArray(obj.source_ids)
    ? (obj.source_ids as unknown[]).filter(isStr)
    : [];
  emitSources(emit, sourceIds, evidence);

  const title = isStr(obj.title) ? obj.title : '';
  const insights = Array.isArray(obj.key_insights)
    ? (obj.key_insights as unknown[]).filter(isStr)
    : [];
  const answer = [title, ...insights.map((b) => `• ${b}`)]
    .filter(Boolean)
    .join('\n');
  emit({ type: 'text', text: answer || 'No answer produced.' });
  emit({ type: 'done', finalText: answer || undefined });
}

/** Cloud /ai-synthesize response: {title, key_insights string, themes, source_links}. */
function emitCloud(
  emit: (e: NormalizedEvent) => void,
  res: any,
  evidence: EvidenceItem[],
): void {
  const r = res || {};
  const linkIds: string[] = Array.isArray(r.source_links)
    ? r.source_links.flatMap((s: any) => s?.source_ids || []).filter(isStr)
    : [];
  emitSources(emit, linkIds.length ? linkIds : evidence.map((e) => e.uniqueid), evidence);

  const title = isStr(r.title) ? r.title : '';
  let insights = '';
  if (isStr(r.key_insights)) insights = r.key_insights;
  else if (isStr(r.keyInsights)) insights = r.keyInsights;
  else if (Array.isArray(r.themes)) {
    insights = r.themes
      .flatMap((t: any) => (t?.bullets || []).map((b: any) => `• ${b?.text || ''}`))
      .filter(Boolean)
      .join('\n');
  }
  const answer = [title, insights].filter(Boolean).join('\n');
  emit({ type: 'text', text: answer || 'No answer produced.' });
  emit({ type: 'done', finalText: answer || undefined });
}
