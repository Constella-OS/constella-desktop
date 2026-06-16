/**
 * Chunker — splits a document's extracted text into small overlapping-free
 * chunks for per-chunk embedding. Mirrors the backend's
 * `create_multivector_chunks` (integrations/obsidian_v2/services/indexing.py)
 * so local indexing produces the same granularity as the cloud obsidian flow:
 *   - documents under CHUNK_THRESHOLD chars are NOT chunked (the parent note
 *     vector alone covers them).
 *   - longer docs are grouped ~LINES_PER_CHUNK lines at a time, each group
 *     capped at ~MAX_CHUNK_SIZE chars (a single over-long line is hard-split).
 *   - at most MAX_CHUNKS chunks per document.
 *
 * Each chunk carries its char offsets back into the source text so the parent
 * note can be re-derived / highlighted later.
 */

export const CHUNK_THRESHOLD = 300; // don't chunk bodies shorter than this
export const MAX_CHUNK_SIZE = 250; // ~chars per chunk
export const LINES_PER_CHUNK = 3; // group this many lines before flushing
export const MAX_CHUNKS = 199; // hard cap per document
/** Chars of the body folded into the PARENT note vector (title + this much). */
export const PARENT_BODY_CHARS = 2000;

export interface Chunk {
  text: string;
  index: number;
  start: number;
  end: number;
}

/**
 * Split `text` into chunks. Returns [] when the body is short enough that the
 * parent vector suffices (caller still embeds the parent).
 */
export function chunkDocument(text: string): Chunk[] {
  const body = (text ?? '').trim();
  if (body.length <= CHUNK_THRESHOLD) return [];

  const chunks: Chunk[] = [];
  const push = (raw: string, start: number, end: number) => {
    const t = raw.trim();
    if (!t) return;
    chunks.push({ text: t, index: chunks.length, start, end });
  };

  // Walk lines, tracking absolute char offsets into `body` (including the
  // newline chars we split on) so start/end stay accurate.
  const lines = body.split('\n');
  let groupLines: string[] = [];
  let groupStart = 0; // offset of the current group's first char
  let cursor = 0; // running offset as we consume lines
  let groupLen = 0; // length of the joined group so far

  const flush = (endOffset: number) => {
    if (groupLines.length === 0) return;
    push(groupLines.join('\n'), groupStart, endOffset);
    groupLines = [];
    groupLen = 0;
  };

  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS; i += 1) {
    const line = lines[i];
    const lineStart = cursor;
    // +1 for the '\n' that split() removed (except conceptually past the end).
    cursor += line.length + 1;

    // A single line longer than the cap: flush any pending group, then hard-
    // split this line into MAX_CHUNK_SIZE windows.
    if (line.length > MAX_CHUNK_SIZE) {
      flush(lineStart);
      for (
        let off = 0;
        off < line.length && chunks.length < MAX_CHUNKS;
        off += MAX_CHUNK_SIZE
      ) {
        const slice = line.slice(off, off + MAX_CHUNK_SIZE);
        push(slice, lineStart + off, lineStart + off + slice.length);
      }
      groupStart = cursor;
      continue;
    }

    if (groupLines.length === 0) groupStart = lineStart;
    // Adding this line would overflow the char cap → flush first.
    if (groupLen + line.length > MAX_CHUNK_SIZE && groupLines.length > 0) {
      flush(lineStart);
      groupStart = lineStart;
    }
    groupLines.push(line);
    groupLen += line.length + 1;

    if (groupLines.length >= LINES_PER_CHUNK) {
      flush(cursor - 1);
      groupStart = cursor;
    }
  }
  if (chunks.length < MAX_CHUNKS) flush(Math.min(cursor, body.length));

  return chunks;
}

/** Build the string folded into the PARENT note vector: title + a leading
 *  slice of the body. Matches the backend's "title + first 2000 chars". */
export function parentEmbedText(title: string, body: string): string {
  const head = (body ?? '').trim().slice(0, PARENT_BODY_CHARS);
  return `${(title ?? '').trim()}\n${head}`.trim();
}
