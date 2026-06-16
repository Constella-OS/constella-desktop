/**
 * runModelOnce — provider binding for the model-bound steps (generateQueries,
 * filterRank, synthesize). One-shot (non-streaming) text generation on the
 * selected provider.
 *
 * NOTE: cloud one-shot from the renderer is not wired yet — the cloud recall
 * answer still streams over the Stella V2 WS (handled in useProviderRecall), and
 * a stateless `/pipeline/synthesize` backend endpoint is the planned cloud path.
 * So for `provider === 'cloud'` this returns null and the caller degrades
 * gracefully (passthrough / identity). local / claude-cli / codex run via the
 * bridged main-process runOnce.
 */
import { runOnce } from '../../providers/runOnce';
import type { StepCtx } from '../types';

export async function runModelOnce(
  ctx: StepCtx,
  prompt: string,
  systemPrompt?: string,
): Promise<string | null> {
  if (ctx.provider === 'cloud') return null; // see note above
  try {
    const res = await runOnce({
      providerId: ctx.provider,
      prompt,
      systemPrompt,
      model: ctx.modelId,
    });
    return res.ok && res.text ? res.text : null;
  } catch (e: any) {
    console.warn('[ai-pipeline] runModelOnce failed:', e?.message || e);
    return null;
  }
}
