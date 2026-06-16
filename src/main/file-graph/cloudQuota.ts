/**
 * Cloud graph-LLM quota state (main process).
 *
 * When the backend's /graph_llm endpoint returns 429 (monthly AI quota
 * exhausted for the user's tier), we remember it here so:
 *   - the engine stops hammering the endpoint (calls are suppressed for
 *     SUPPRESS_MS, then one probe call rechecks — quotas reset monthly),
 *   - the renderer can show the "Auto Connections Limit reached" banner
 *     (pushed over 'file-graph:quota-exceeded', queried on mount via the
 *     'file-graph:quota-status' IPC handler).
 *
 * In-memory only by design: after an app restart the first cloud call either
 * succeeds (quota reset / upgraded) or re-trips 429 within one tick, which
 * re-arms the banner. State: exceededAt timestamp + the tier the backend
 * reported.
 */

// Recheck window — long enough to stop burning ticks, short enough that an
// upgrade or month rollover gets noticed the same day.
const SUPPRESS_MS = 6 * 3_600_000;

let exceededAt = 0;
let exceededTier = '';

/** Record a 429 from the backend and push the banner event to the renderer. */
export function markCloudQuotaExceeded(tier: string): void {
  exceededAt = Date.now();
  exceededTier = tier || '';
  console.warn(
    `[file-graph:cloud-quota] monthly AI quota exhausted (tier=${exceededTier || 'unknown'}) — cloud graph calls suppressed for ${SUPPRESS_MS / 3_600_000}h`,
  );
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { mainWindow } = require('../main');
    mainWindow?.webContents?.send('file-graph:quota-exceeded', {
      tier: exceededTier,
    });
  } catch {
    /* window gone / not ready */
  }
}

/** True while cloud graph calls should be suppressed (recent 429). */
export function cloudQuotaExceeded(): boolean {
  return exceededAt > 0 && Date.now() - exceededAt < SUPPRESS_MS;
}

/** Renderer-facing snapshot for the home banner's initial render. */
export function cloudQuotaStatus(): { exceeded: boolean; tier: string } {
  return { exceeded: cloudQuotaExceeded(), tier: exceededTier };
}
