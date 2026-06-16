/**
 * Balanced-brace JSON extractor — the CLI provider binding.
 *
 * claude-cli / codex stream free-form text (often with leading "thinking" and
 * trailing prose), so we can't force a structured response_format on them. We
 * instead instruct them strictly (see structuredPrompt.ts) and then pull the one
 * JSON object out of their output here.
 *
 * The scan is STRING-AWARE: braces inside "..." string literals (and escaped
 * quotes) do not change depth, so a `}` inside a string value can't prematurely
 * close the object. PURE module — safe to unit test in isolation.
 */

/**
 * Return the substring of the first complete top-level `{...}` object in `text`,
 * or null if none is balanced. Ignores everything before the first `{` and after
 * the matching `}` (prose, markdown fences, chain-of-thought).
 */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      // Inside a string: only `\` (escape) and an unescaped `"` matter.
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never balanced
}

/**
 * Extract + JSON.parse the first balanced object. Strips ```json fences first as
 * a convenience. Returns null on no-object / parse failure (caller decides
 * whether to re-ask the model).
 */
export function parseJsonObject<T = unknown>(text: string): T | null {
  if (!text) return null;
  const defenced = text.replace(/```(?:json)?/gi, '');
  const block = extractJsonObject(defenced);
  if (!block) return null;
  try {
    return JSON.parse(block) as T;
  } catch {
    return null;
  }
}
