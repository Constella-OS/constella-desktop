/**
 * Tiered recall model policy.
 *
 * The FIRST answer to a discovery should feel instant, so it runs on a fast,
 * cheap model (Haiku). FOLLOW-UP turns are where the user digs in, so they get
 * the stronger Sonnet 4.6 with a high extended-thinking budget. Only claude-cli
 * is tiered here — other providers (codex / local / cloud) keep their own model
 * selection, so we return an empty override for them.
 */
import type { ProviderId } from './types';

export const RECALL_FOLLOWUP_THINKING_TOKENS = 24_000; // "high"

export function recallModelFor(
  provider: ProviderId,
  role: 'initial' | 'followup',
): { model?: string; thinkingTokens?: number } {
  if (provider !== 'claude-cli') return {};
  return role === 'followup'
    ? {
        model: 'claude-sonnet-4-6',
        thinkingTokens: RECALL_FOLLOWUP_THINKING_TOKENS,
      }
    : { model: 'haiku' };
}
