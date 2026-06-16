/**
 * TASK: initialProjectGenerate — query → retrieved evidence → themed synthesis.
 *
 * Powers the home recall UI. Reuses the shared `retrieve` fragment (so it gets
 * local/cloud/hybrid evidence for free), then `synthesizeThemes`:
 *   - cloud → existing /initial-project-generate (evidence passed as attached_sources)
 *   - local/CLI → schema-bound themed synthesis over the evidence
 *
 * Input:  string (the user query) — also set on ctx.query by the entry point.
 * Output: the themes panel payload ({themes, projectName?, sourcesSummary?, ...}).
 */
import { recipe } from '../runner';
import { retrieve } from './retrieve';
import { synthesizeThemes } from '../steps/synthesizeThemes';
import type { Step } from '../types';

export const initialProjectGenerate: Step<string, unknown> = recipe<
  string,
  unknown
>([
  retrieve as Step<unknown, unknown>,
  synthesizeThemes as Step<unknown, unknown>,
]);
