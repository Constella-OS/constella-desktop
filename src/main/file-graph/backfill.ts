/**
 * One-time text backfill: populate the main-side text store from files that
 * were already indexed before the graph engine existed.
 *
 * Their text lives only in renderer RxDB (main can't read it), so we read the
 * file-index sync manifests (which list every indexed path) and re-extract via
 * the same `extractToText` the indexer uses. Throttled, capped, and yields the
 * event loop between files so it never blocks the UI.
 */
import path from 'path';
import fsp from 'fs/promises';
import { app } from 'electron';
import { v5 as uuidv5 } from 'uuid';
import { listSources } from '../file-index/sources';
import { extractToText } from '../file-index/extractors';
import { putGraphDoc, hasGraphDocSync } from './textStore';
import { MAX_BACKFILL_DOCS } from './constants';

// Must match file-index/records.ts so we derive the same parent ids.
const FILE_INDEX_NAMESPACE = '8f4a1d2e-7c63-4b9a-9f0e-1a2b3c4d5e6f';
function parentIdForPath(p: string): string {
  return uuidv5(`file:${p}`, FILE_INDEX_NAMESPACE);
}
function manifestPath(sourceId: string): string {
  return path.join(app.getPath('userData'), 'file-index', `${sourceId}.json`);
}
function titleFromPath(p: string): string {
  return path.basename(p).replace(/\.[^.]+$/, '');
}

let backfillDone = false;

/**
 * Fill the text store for already-indexed files. Idempotent (skips files that
 * already have stored text) and runs at most once per launch. `yieldFn` is the
 * scheduler's setImmediate yield so this stays non-blocking.
 */
export async function backfillTextStore(
  yieldFn: () => Promise<void>,
): Promise<number> {
  if (backfillDone) return 0;
  backfillDone = true;
  let done = 0;
  let sources;
  try {
    sources = await listSources();
  } catch {
    return 0;
  }
  for (const src of sources) {
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath(src.id), 'utf8'));
    } catch {
      continue; // no manifest yet for this source
    }
    for (const [p, entry] of Object.entries(manifest)) {
      if (done >= MAX_BACKFILL_DOCS) {
        // eslint-disable-next-line no-console
        console.warn(`[file-graph] backfill cap reached (${done}); stopping`);
        return done;
      }
      const parentId = (entry as any)?.parentId || parentIdForPath(p);
      if (hasGraphDocSync(parentId)) continue;
      const outcome = await extractToText(p);
      if (outcome.ok) {
        await putGraphDoc({
          parentId,
          title: titleFromPath(p),
          path: p,
          text: outcome.text,
        });
        done += 1;
      }
      await yieldFn();
    }
  }
  if (done > 0) {
    // eslint-disable-next-line no-console
    console.log(`[file-graph] text backfill stored ${done} docs`);
  }
  return done;
}
