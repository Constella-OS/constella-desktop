/**
 * synthesizeThemes — the synthesis tail for `initialProjectGenerate` (home recall
 * UI). Produces the `{themes: [...]}` panel payload (NOT chat frames — this
 * renders in the Result panel, so it RETURNS the object rather than streaming).
 *
 * Provider dispatch:
 *   - cloud → reuse the EXISTING POST /initial-project-generate endpoint. Our
 *     retrieved evidence (which includes local-only indexed files the cloud
 *     can't see) is passed as `attached_sources`, so the cloud synthesis is
 *     grounded in local data too. No new backend endpoint needed.
 *   - local / claude-cli / codex → synthesize over the retrieved evidence using
 *     the projectThemes schema (GBNF grammar locally / strict-prompt+extractor
 *     for CLI).
 */
import { CanvasApi } from '../../canvas/canvas-api';
import { runModelOnce } from '../binding/runModel';
import { buildStructuredPrompt } from '../binding/structuredPrompt';
import { parseJsonObject } from '../binding/jsonExtract';
import { projectThemesSchema } from '../schemas/projectThemes.schema';
import type { EvidenceItem, Step } from '../types';

export const synthesizeThemes: Step<EvidenceItem[], unknown> = async (
  evidence,
  ctx,
) => {
  const query = ctx.query || '';

  // Cloud: the existing endpoint does its own retrieval + themed synthesis. We
  // merge the user's attached sources (from the ask bar) with our retrieved
  // evidence (incl. local-only indexed files) and pass both as attached_sources
  // so the cloud synthesis is grounded in local data too.
  if (ctx.provider === 'cloud') {
    if (!ctx.accessToken) return null;
    const userAttached = ctx.attachedSources ?? [];
    const seen = new Set(userAttached.map((s) => s.id));
    const evidenceAttached = evidence
      .filter((e) => e.uniqueid && !seen.has(e.uniqueid))
      .slice(0, 20)
      .map((e) => ({
        id: e.uniqueid,
        title: e.title || '',
        summary: e.snippet || '',
        content: e.snippet || '',
        source_url: '',
        source_type: 'file',
      }));
    const merged = [...userAttached, ...evidenceAttached].slice(0, 20);
    try {
      return await CanvasApi.initialProjectGenerate(query, ctx.accessToken, {
        // source_type is widened to string on AttachedSource; the endpoint
        // accepts 'file' | 'link' — coerce at this boundary.
        attachedSources: merged as any,
      });
    } catch (e: any) {
      console.warn('[ai-pipeline] initial-project-generate failed:', e?.message || e);
      return null;
    }
  }

  // Local / CLI: synthesize themes over the retrieved evidence.
  const base = `Query: ${query}

Evidence (each tagged with its uniqueid):
${renderEvidence(evidence)}

Produce a themed synthesis of the evidence that answers the query. Group related
points into 3–5 themes with 2–4 bullets each; cite the uniqueids you used; end
with one open-threads theme (open=true).`;

  const text = await runModelOnce(
    ctx,
    buildStructuredPrompt(base, projectThemesSchema),
  );
  const parsed = text ? parseJsonObject<Record<string, unknown>>(text) : null;
  if (!parsed) return null;
  // Fill the fields the Result panel expects so local/CLI output renders like
  // the cloud payload (which returns projectName / sourcesSummary / etc.).
  return {
    projectName: query,
    projectEmoji: '✨',
    sourcesSummary: '',
    attachedSources: [],
    ...parsed,
  };
};

function renderEvidence(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) =>
      `[${e.uniqueid}] ${e.title || '(untitled)'}\n${
        e.content || e.snippet || ''
      }`.slice(0, 800),
    )
    .join('\n\n');
}
