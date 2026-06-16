/**
 * structuredPrompt — build the strict "emit only JSON" instruction appended to a
 * synthesis prompt for the CLI providers (claude-cli / codex), which can't take
 * a real response_format. Paired with jsonExtract.ts on the output side.
 *
 * (Cloud uses the backend's response_format; local Qwen uses a GBNF grammar
 *  derived from the same schema in the worker — neither needs this prompt, but
 *  it's harmless to include and keeps one code path.)
 */
import type { PipelineSchema } from '../types';

export function buildStructuredPrompt(
  base: string,
  schema: PipelineSchema,
): string {
  const schemaJson = JSON.stringify(schema.schema, null, 2);
  return `${base}

Output ONLY a single JSON object that matches this schema. Do not include any
prose, explanation, or markdown fences before or after it. Begin your output
with "{" and end with "}".

JSON schema (${schema.name}):
${schemaJson}`;
}
