/**
 * TASK: aiSearch — query → ranked evidence → structured insights.
 *
 * The "AI Node / internal AI search" feature (the /search/ai-search shape):
 * retrieve → rank → synthesize into {title, key_insights, source_ids}. Streams
 * the same NormalizedEvents (sources pills + answer + done) so it renders via
 * applyNormalizedToChat. Reuses the shared `retrieve` fragment, so it inherits
 * local/cloud/hybrid.
 *
 * (Was named `recall` — renamed because the conversational recall surfaces use
 * `aiChat` and the home ask bar uses `initialProjectGenerate`; this structured-
 * insights shape belongs to the AI Node feature.)
 *
 * Input:  string (the user query) — also set on ctx.query by the entry point.
 * Output: the recallInsights object (or null when cloud-synth defers to the WS).
 */
import { recipe } from '../runner';
import { retrieve } from './retrieve';
import { filterRank } from '../steps/filterRank';
import { synthesizeInsights } from '../steps/synthesizeInsights';
import type { Step } from '../types';

export const aiSearch: Step<string, unknown> = recipe<string, unknown>([
  retrieve as Step<unknown, unknown>,
  filterRank as Step<unknown, unknown>,
  synthesizeInsights as Step<unknown, unknown>,
]);
