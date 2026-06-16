/**
 * Obsidian `[[ ]]` wikilink backlinking for the local file index.
 *
 * Ports the cloud Obsidian pipeline's link behavior (backend
 * integrations/obsidian_v2/parsing.py + services/connections.py) to the
 * local indexer:
 *   - parseWikilinks: pull `[[Target]]` references out of a note's text
 *     (handles `[[Target|alias]]` and `[[Target#heading]]`; ignores `[[ ]]`
 *     inside fenced/inline code), deduped.
 *   - buildWikilinkEnvelopes: resolve those targets to other notes in the SAME
 *     vault and produce one typed `references` edge per resolved pair, in the
 *     exact envelope shape the renderer's `file-graph:connections` listener
 *     already consumes. Resolution mirrors Obsidian: a path-qualified link
 *     (`[[folder/Note]]`) matches by vault-relative path, a bare link
 *     (`[[Note]]`) matches by filename, and attachment links that keep their
 *     extension (`[[Paper.pdf]]`) match the indexed attachment file; when two
 *     files share a filename the bare link goes to the shallowest path
 *     (deterministic tie-break), which is also when Obsidian itself writes
 *     path-qualified links.
 *
 * Matching is case-insensitive and Unicode-NFC-normalized (macOS stores
 * filenames NFD, so `[[Café]]` typed in a note wouldn't otherwise match
 * `Café.md` on disk).
 *
 * The note id for a file is deterministic (`parentIdForPath`), so the
 * title→id map can be rebuilt from the manifest alone (no re-reading files).
 * Targets that don't resolve to an existing note are dropped (no stub notes) —
 * the applier also requires both endpoints to exist locally.
 */
import path from 'path';
import { createGraphConnection } from '../../models/GraphConnection';
import { parentIdForPath } from './records';

// One `file-graph:connections` envelope — mirrors src/main/file-graph/connections.ts
// (the auto-connection engine) so we reuse the renderer's existing upsert path.
export interface WikilinkEnvelope {
  source: string;
  target: string;
  data: {
    connectionId: string;
    connectionType: string;
    connectionStrength: number;
    connectionContext: string;
    sourceIntegration: string;
    createdAt: string;
    isAiSuggestion: boolean;
  };
}

// Minimal manifest shape this module needs (kept local to avoid a syncService
// import cycle). Real entries carry more fields; we only read these.
interface WikilinkManifestEntry {
  parentId: string;
  outgoingLinks?: string[];
}
type WikilinkManifest = Record<string, WikilinkManifestEntry>;

/**
 * Extract the target note names from a note body's `[[ ]]` wikilinks.
 * - `[[Note|alias]]` → "Note"  (drop the display alias after `|`)
 * - `[[Note#Heading]]` → "Note" (resolve to the note, not the literal heading)
 * Code is ignored: fenced blocks (``` / ~~~, including an unterminated fence,
 * which Obsidian also renders as code to end-of-file) and inline `code` spans —
 * `[[ ]]` inside them is literal text, not a link.
 * Trims whitespace, drops empties, dedupes (preserving first-seen order).
 */
export function parseWikilinks(text: string): string[] {
  if (!text) return [];
  const withoutCode = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const matches = withoutCode.match(/\[\[(.*?)\]\]/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    // Strip the surrounding [[ ]], then the alias (|) and heading (#) parts.
    const inner = raw.slice(2, -2);
    const target = inner.split('|')[0].split('#')[0].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Normalize a title for matching: trim, lowercase, and Unicode-NFC so link
 *  text (NFC) matches macOS on-disk filenames (NFD). Closer to real Obsidian
 *  link resolution than the backend's exact-string match. */
export function normalizeTitle(title: string): string {
  return title.normalize('NFC').trim().toLowerCase();
}

/** Strip the extension off a filename ("Note.md" → "Note"). */
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

/** Vault-relative path, forward-slashed (extension kept). */
function relPathForPath(sourceRoot: string, absPath: string): string {
  return path.relative(sourceRoot, absPath).split(path.sep).join('/');
}

/** Strip the extension off the basename of a relative path — the directory
 *  part is untouched (a dotted folder name must survive). */
function stripExtFromRelPath(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  if (slash < 0) return stripExtension(relPath);
  return relPath.slice(0, slash + 1) + stripExtension(relPath.slice(slash + 1));
}

/**
 * Resolve every cached `[[link]]` across the vault's manifest into typed
 * `references` edges. Builds four normalized lookup maps over all files in the
 * source, tried most-specific-first when resolving a link:
 *   1. vault-relative path WITH extension  — `[[folder/Paper.pdf]]`
 *   2. vault-relative path, extension off  — `[[folder/Note]]`
 *   3. bare filename WITH extension        — `[[Paper.pdf]]` (Obsidian keeps
 *      the extension when linking non-markdown attachments)
 *   4. bare filename, extension off        — `[[Note]]`
 * Filename collisions within a map resolve to the shallowest, then
 * lexicographically-first path, so the winner is deterministic. Then for each
 * note's outgoing links it emits one envelope per resolved target (skipping
 * self-links and unresolved targets). Edge ids are deterministic, so re-running
 * upserts the same edges instead of duplicating.
 */
export function buildWikilinkEnvelopes(
  manifest: WikilinkManifest,
  sourceRoot: string,
): WikilinkEnvelope[] {
  type Candidate = { id: string; relPath: string };
  const depthOf = (relPath: string): number => relPath.split('/').length;
  // Insert into one lookup map, keeping the shallowest/lexicographically-first
  // path when two files produce the same key (e.g. Note.md in two folders).
  const addCandidate = (
    map: Map<string, Candidate>,
    key: string,
    candidate: Candidate,
  ): void => {
    const existing = map.get(key);
    if (
      !existing ||
      depthOf(candidate.relPath) < depthOf(existing.relPath) ||
      (depthOf(candidate.relPath) === depthOf(existing.relPath) &&
        candidate.relPath < existing.relPath)
    ) {
      map.set(key, candidate);
    }
  };

  const byPathExt = new Map<string, Candidate>();
  const byPath = new Map<string, Candidate>();
  const byTitleExt = new Map<string, Candidate>();
  const byTitle = new Map<string, Candidate>();
  for (const [absPath, entry] of Object.entries(manifest)) {
    const id = entry.parentId || parentIdForPath(absPath);
    const relPath = relPathForPath(sourceRoot, absPath);
    const candidate: Candidate = { id, relPath };
    addCandidate(byPathExt, normalizeTitle(relPath), candidate);
    addCandidate(
      byPath,
      normalizeTitle(stripExtFromRelPath(relPath)),
      candidate,
    );
    const baseName = path.basename(relPath);
    addCandidate(byTitleExt, normalizeTitle(baseName), candidate);
    addCandidate(byTitle, normalizeTitle(stripExtension(baseName)), candidate);
  }

  const createdAt = new Date().toISOString();
  const envelopes: WikilinkEnvelope[] = [];
  for (const [absPath, entry] of Object.entries(manifest)) {
    const links = entry.outgoingLinks;
    if (!links || links.length === 0) continue;
    const sourceId = entry.parentId || parentIdForPath(absPath);
    for (const linkTitle of links) {
      // Most-specific map first: exact path+ext, then path, then name+ext,
      // then bare name. (A bare link to a root-level file also hits the path
      // maps first — same answer either way.)
      const norm = normalizeTitle(linkTitle);
      const targetId = (
        byPathExt.get(norm) ??
        byPath.get(norm) ??
        byTitleExt.get(norm) ??
        byTitle.get(norm)
      )?.id;
      if (!targetId || targetId === sourceId) continue;
      // Hard wikilink: type 'references', full strength, not AI-suggested.
      const edge = createGraphConnection({
        currentNoteId: sourceId,
        relatedNoteId: targetId,
        direction: 'outgoing',
        type: 'references',
        strength: 1,
        context: '',
        sourceIntegration: 'obsidian',
        is_ai_suggestion: false,
        createdAt,
      });
      envelopes.push({
        source: sourceId,
        target: targetId,
        data: {
          connectionId: edge.uniqueid,
          connectionType: edge.type,
          connectionStrength: edge.strength,
          connectionContext: edge.context,
          sourceIntegration: edge.sourceIntegration,
          createdAt: edge.createdAt,
          isAiSuggestion: false,
        },
      });
    }
  }
  return envelopes;
}
