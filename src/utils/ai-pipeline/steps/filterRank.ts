/**
 * filterRank — model-bound step: the "equalizer" that re-ranks merged evidence
 * by actual relevance to the query (ctx.query).
 *
 * This is what makes a hybrid (local + cloud) merge coherent: local 512-dim and
 * cloud 768-dim scores aren't comparable, so we never sort the merged pile by
 * score. Instead the model reads titles/snippets and returns the kept ids in
 * relevance order. DEGRADES to identity (cap to topK) when the model is
 * unavailable or the provider is cloud (one-shot not wired yet).
 */
import { runModelOnce } from '../binding/runModel';
import { parseJsonObject } from '../binding/jsonExtract';
import type { EvidenceItem, Step } from '../types';

interface RankResult {
  keep?: string[];
}

export const filterRank: Step<EvidenceItem[], EvidenceItem[]> = async (
  evidence,
  ctx,
) => {
  const cap = ctx.topK ?? 20;
  if (!Array.isArray(evidence) || evidence.length <= 1) return evidence;

  // Re-rank is an EXTRA model call — reserve it for the warm local worker. Cloud
  // (no one-shot) and CLI (expensive per-step spawn) degrade to the retrieval
  // order, capped at topK.
  if (ctx.provider !== 'local') return evidence.slice(0, cap);

  const query = ctx.query || '';
  const text = await runModelOnce(ctx, buildRankPrompt(query, evidence));
  if (!text) return evidence.slice(0, cap); // identity degrade

  const keep = parseJsonObject<RankResult>(text)?.keep;
  if (!Array.isArray(keep) || keep.length === 0) return evidence.slice(0, cap);

  // Reorder evidence to the model's kept-id order; drop the rest.
  const byId = new Map(evidence.map((e) => [e.uniqueid, e]));
  const ranked: EvidenceItem[] = [];
  for (const id of keep) {
    const it = byId.get(id);
    if (it) ranked.push(it);
  }
  return (ranked.length ? ranked : evidence).slice(0, cap);
};

function buildRankPrompt(query: string, evidence: EvidenceItem[]): string {
  const list = evidence
    .map((e, i) =>
      `${i + 1}. [${e.uniqueid}] ${e.title || '(untitled)'} — ${
        e.snippet || ''
      }`.slice(0, 300),
    )
    .join('\n');
  return `Query: ${query}

Candidate sources:
${list}

Return ONLY a JSON object {"keep": string[]} listing the uniqueids (the values in [brackets]) that are actually relevant to the query, most relevant first. Drop irrelevant ones. No prose.`;
}
