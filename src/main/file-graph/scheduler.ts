/**
 * Background scheduler for the knowledge-graph engine.
 *
 * A separate ticker from the file-index loop. Each tick (guarded by `busy`):
 *   1. yields entirely if the user is using Recall/chat (recall-first)
 *   2. one-time text backfill of the already-indexed corpus
 *   3. PRIMARY: per-record auto-connection (queries → search → classify → edges)
 *   4. concepts from note communities + themes from concept communities (hourly)
 * Everything is awaited and yields via setImmediate; all LLM work runs on the
 * shared worker via runGraphLLM — so the main thread never blocks. All state is
 * in the SQLite graph store (graphDb), so a tick reads/writes synchronously.
 */
import { loadEdgeStore, flushEdgeStore } from './edgeStore';
import { runConnectionPass } from './connections';
import { runConceptPass, runThemePass } from './synth';
import { backfillTextStore } from './backfill';
import { graphProviderAvailable } from './provider';
import { isRecallActive } from '../providers/runner';
import {
  IDLE_TICK_MS,
  CONCEPT_INTERVAL_MS,
  SYNTH_INTERVAL_MS,
  BOOT_DELAY_MS,
  MAX_PAGES_PER_TICK,
  MAX_PAGES_PER_HOUR,
  RECALL_COOLDOWN_MS,
} from './constants';

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let nudged = false;
let backfilled = false;
// Concept synthesis runs on a fast cadence; theme synthesis hourly (decoupled,
// mirroring agents-slack). Tracked separately so themes don't drag concepts.
let lastConceptAt = 0;
let lastThemeAt = 0;
let hourStart = 0;
let pagesThisHour = 0;

const yieldToLoop = (): Promise<void> =>
  new Promise<void>((r) => setImmediate(r));

/** Nudge from the file-index sync after new chunks land (text already stored). */
export function notifyNewChunks(_count: number): void {
  nudged = true;
}

async function tick(): Promise<void> {
  if (busy) {
    console.log('[file-graph:tick] skip — previous tick still running');
    return;
  }
  busy = true;
  try {
    // Recall-first: if the user is on the shared worker, do nothing this tick.
    if (isRecallActive(RECALL_COOLDOWN_MS)) {
      console.log('[file-graph:tick] skip — recall/chat active (recall-first)');
      return;
    }
    // Gate: nothing runs unless SOME background LLM backend is usable.
    const providerOk = await graphProviderAvailable();
    if (!providerOk) {
      console.log(
        '[file-graph:tick] skip — no CLI provider (claude/codex) configured. Indexing continues; connections/concepts are skipped until a CLI provider is set in Settings → AI Config.',
      );
      return;
    }

    loadEdgeStore(); // opens the SQLite graph store
    if (!backfilled) {
      backfilled = true;
      await backfillTextStore(yieldToLoop);
    }

    const now = Date.now();
    if (now - hourStart > 3_600_000) {
      hourStart = now;
      pagesThisHour = 0;
    }

    console.log('[file-graph:tick] start — provider ok, running connection pass');

    // PRIMARY: per-record auto-connection (the "web of thoughts"). Throttled +
    // recall-gated; each record is ~2 LLM calls so the per-tick budget is small.
    const connected = await runConnectionPass(yieldToLoop);
    if (nudged) nudged = false;

    // CONCEPTS — fast cadence (every CONCEPT_INTERVAL_MS), throttled by the
    // per-hour page cap. Concepts cluster note communities; running them often
    // keeps Discoveries generating as the note graph grows.
    let concepts = 0;
    const conceptDue = now - lastConceptAt > CONCEPT_INTERVAL_MS;
    if (conceptDue && pagesThisHour < MAX_PAGES_PER_HOUR) {
      lastConceptAt = now;
      const budget = Math.min(
        MAX_PAGES_PER_TICK,
        MAX_PAGES_PER_HOUR - pagesThisHour,
      );
      concepts = await runConceptPass(yieldToLoop, budget);
      pagesThisHour += concepts;
    }

    // THEMES — hourly (every SYNTH_INTERVAL_MS). Themes cluster *concepts* into
    // higher-level groups, so they only need to run occasionally once enough
    // concepts + concept↔concept edges exist to form communities.
    let themes = 0;
    const themeDue = now - lastThemeAt > SYNTH_INTERVAL_MS;
    if (themeDue) {
      lastThemeAt = now;
      themes = await runThemePass(yieldToLoop, 2);
    }

    console.log(
      `[file-graph:tick] done — connected ${connected} record(s), made ${concepts} concept(s)` +
        `${themeDue ? `, ${themes} theme(s)` : ''}` +
        `${
          conceptDue
            ? ''
            : ` (concepts next in ${Math.round(
                (CONCEPT_INTERVAL_MS - (now - lastConceptAt)) / 1000,
              )}s)`
        }`,
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[file-graph] tick error:', e?.message ?? e);
  } finally {
    busy = false;
  }
}

export function startGraphScheduler(): void {
  if (timer) return;
  console.log(
    `[file-graph:scheduler] started — first tick in ${BOOT_DELAY_MS / 1000}s, then every ${IDLE_TICK_MS / 1000}s`,
  );
  bootTimer = setTimeout(() => {
    tick().catch(() => undefined);
  }, BOOT_DELAY_MS);
  timer = setInterval(() => {
    tick().catch(() => undefined);
  }, IDLE_TICK_MS);
}

export function stopGraphScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  void flushEdgeStore();
}

/** Manual trigger (file-graph:run-now). */
export async function runGraphNow(): Promise<void> {
  console.log('[file-graph:scheduler] manual run-now triggered');
  // A manual run is an explicit request to generate — don't let the cadence
  // throttles defer the concept/theme passes, so the user sees results now.
  lastConceptAt = 0;
  lastThemeAt = 0;
  await tick();
}
