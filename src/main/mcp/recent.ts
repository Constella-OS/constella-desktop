/**
 * Time-ordered knowledge-base reads for CLI agents, fully in the MAIN process
 * (no renderer, no cloud) — they answer whenever the Electron process is alive,
 * exactly like search_local_notes. Backs two MCP tools:
 *
 *   - recent_notes: the user's most recently created/updated notes, newest
 *     first. Time-ordered, NOT a search — this is how an agent (e.g. the Riley
 *     content engine) sees "what is the user thinking about right now" without
 *     guessing a query.
 *   - list_tags: the user's FULL tag vocabulary (every tag, not just used
 *     ones). Lets an agent (e.g. Riley) search by tag / tag created notes with
 *     the user's REAL tag names instead of inventing near-misses.
 *
 * Both read the SQLite main-db; responses are trimmed hard because every byte
 * the CLI receives is paid for in tokens.
 */
import { notesRecent, tagsFindAll } from '../main-db/api';

const SNIPPET_CHARS = 220;

/** One trimmed note in a recent_notes response. */
export interface RecentNote {
  id: string;
  title: string;
  snippet: string;
  type: string;
  lastModified?: number;
  tags?: string[];
}

/** One tag in a list_tags response. */
export interface TagEntry {
  id: string;
  name: string;
  color?: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseDoc(raw: string): Record<string, any> | null {
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

function toSnippet(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_CHARS);
}

/** Tag names on a doc, de-blanked. Names live on the doc (junction has ids). */
function docTagNames(doc: Record<string, any>): string[] {
  return Array.isArray(doc.tags)
    ? doc.tags.map((t) => String(t?.name ?? '').trim()).filter(Boolean)
    : [];
}

/**
 * recent_notes handler. Returns the newest notes, optionally filtered to
 * `noteTypes` and with notes carrying any `excludeTagNames` dropped. When
 * excluding, we over-fetch so the post-filter result still reaches `limit`.
 */
export async function recentNotes(args: {
  limit?: number;
  noteTypes?: string[];
  excludeTagNames?: string[];
}): Promise<{ notes: RecentNote[] }> {
  const limit = clampInt(args.limit, 50, 1, 200);
  const noteTypes = Array.isArray(args.noteTypes)
    ? args.noteTypes.map((t) => String(t ?? '').trim()).filter(Boolean)
    : [];
  const exclude = new Set(
    (Array.isArray(args.excludeTagNames) ? args.excludeTagNames : [])
      .map((t) => String(t ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  const fetchLimit = exclude.size ? Math.min(200, limit * 3) : limit;
  const docs = await notesRecent({ limit: fetchLimit, noteTypes });

  const notes: RecentNote[] = [];
  for (const raw of docs) {
    const doc = parseDoc(raw);
    if (!doc?.uniqueid) continue;
    const tags = docTagNames(doc);
    if (exclude.size && tags.some((n) => exclude.has(n.toLowerCase()))) continue;
    notes.push({
      id: String(doc.uniqueid),
      title: String(doc.title || '').trim() || 'Untitled',
      // PDFs/Office docs keep text in fileText (content empty) — same
      // convention as local-search.ts / file-index/records.ts.
      snippet: toSnippet(doc.content || doc.fileText || doc.text),
      type: String(doc.noteType || 'note'),
      ...(typeof doc.lastModified === 'number' ? { lastModified: doc.lastModified } : {}),
      ...(tags.length ? { tags } : {}),
    });
    if (notes.length >= limit) break;
  }
  return { notes };
}

/**
 * list_tags handler. Returns the user's FULL tag vocabulary from the main-db
 * `tags` table (the local-first source the renderer's tag pickers read), sorted
 * alphabetically. No filtering — every tag the user has, so the agent can match
 * the exact existing name when searching/tagging instead of inventing one.
 */
export async function listTags(): Promise<{ tags: TagEntry[] }> {
  const docs = await tagsFindAll();
  const byId = new Map<string, TagEntry>();
  for (const raw of docs) {
    const doc = parseDoc(raw);
    const id = String(doc?.uniqueid ?? '').trim();
    const name = String(doc?.name ?? '').trim();
    if (!id || !name) continue;
    byId.set(id, {
      id,
      name,
      ...(doc?.color ? { color: String(doc.color) } : {}),
    });
  }
  const tags = Array.from(byId.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { tags };
}
