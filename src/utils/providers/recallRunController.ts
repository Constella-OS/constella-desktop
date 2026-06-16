/**
 * recallRunController — guarantees AT MOST ONE bridged recall/discovery run
 * streams into the shared Stella chat at a time.
 *
 * Why this exists: `applyNormalizedToChat` is a global singleton that appends
 * every provider token to whatever `currentStreamingMessageId` currently is. If
 * a previous run (e.g. a slow claude-cli answer for the last canvas) is still
 * streaming when the user starts a NEW canvas or sends a follow-up, its tokens
 * land in the NEW message — the "old Claude answer shows up in the new chat" bug.
 *
 * Both recall entry points (useStartHomeDiscoverySplit + useProviderRecall) call
 * `beginRecallRun()` before kicking off a run; it aborts the previous run's
 * AbortController (which SIGTERMs the claude/codex child via the bridged
 * provider, and short-circuits the pipeline runner + chatStream loops) and hands
 * back a fresh signal to thread through `buildStepCtx`.
 */

// The controller for the single in-flight bridged recall run, if any.
let active: AbortController | null = null;

/**
 * Abort any in-flight recall run and start a new one. Returns the new run's
 * AbortSignal — pass it into `buildStepCtx({ signal })` so the pipeline runner,
 * chatStream loop, and bridged provider all observe the cancellation.
 */
export function beginRecallRun(): AbortSignal {
  abortActiveRecallRun();
  active = new AbortController();
  return active.signal;
}

/**
 * Abort the in-flight recall run, if any (new run superseding it, or teardown
 * such as the recall overlay unmounting). Safe to call when nothing is running.
 */
export function abortActiveRecallRun(): void {
  if (!active) return;
  try {
    active.abort();
  } catch {
    /* already aborted / detached */
  }
  active = null;
}
