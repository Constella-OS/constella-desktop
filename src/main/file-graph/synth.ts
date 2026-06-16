/**
 * Concept + theme synthesis from the connection graph (the layer above
 * auto-connection). Full agents-slack-style pages, stored in SQLite (graphDb).
 *
 *   note↔note communities  → CONCEPT page (## Through-line / Evidence / Tensions
 *                            / Unstated, inline [n] citations, [[wikilinks]])
 *   concept↔concept communities → THEME page (## Through-line / Tensions /
 *                            Unstated, [[concept-slug]] refs)
 *
 * Concepts/themes also get a vector in LanceDB (for semantic linking) and typed
 * concept↔concept edges in graphDb (kind='concept') so themes can cluster them.
 * These live on main and are served to the renderer via the file-graph IPC
 * (they are NOT note-canvas nodes, so they don't go to RxDB).
 */
import { v5 as uuidv5 } from 'uuid';
import {
  searchLanceDB,
  syncVectorsToLanceDB,
} from '../utils/vector-db/vector-db';
import {
  createGraphConnection,
  type GraphConnectionType,
} from '../../models/GraphConnection';
import type { GraphSource } from '../../models/GraphSource';
import { runGraphLLM } from './llm';
import { embedText } from './embed';
import { getGraphDoc } from './textStore';
import { adjacencyAboveStrength } from './edgeStore';
import { detectCommunities } from './community';
import {
  getConcept,
  upsertConcept,
  allConcepts,
  upsertTheme,
  setSlug,
  refForSlug,
  upsertEdge,
  isPageDeleted,
} from './graphDb';
import {
  FILE_GRAPH_NAMESPACE,
  NODE_TYPE_CONCEPT,
  NODE_TYPE_THEME,
  SYNTH_STRENGTH_FLOOR,
  MIN_GROUP,
  PARENT_BODY_CHARS,
  SEMANTIC_THRESHOLD,
  SEMANTIC_MAX_DISTANCE,
  SEMANTIC_TOP_K,
} from './constants';

const CONCEPT_SYSTEM = `You write CONCEPT PAGES for a personal knowledge graph. Given a cluster of related notes the user keeps returning to, synthesize ONE concept page capturing the shared idea — lead with MEANING, not "these notes are about X".

Body, as markdown with the sections that apply:
  ## Through-line — the core idea these notes circle
  ## Evidence — concrete supporting points (bullets ok)
  ## Tensions — where the notes disagree or complicate each other
  ## Unstated — what's implied across them but never written
Cite supporting notes INLINE as [n] (1-based index into the provided notes). When you reference a sibling concept that exists, use a [[concept-slug]] wikilink.
If the notes don't share ONE coherent idea, return {"page": null}.

Output STRICT JSON only:
{"page": {"slug":"kebab-case-<=60","title":"Concept Name","body":"markdown with [n] + [[wikilinks]]","tags":["..."]} | null}`;

const THEME_SYSTEM = `You name and synthesize a THEME across several linked concept pages — the recurring through-line they share. Don't restate the concepts; surface what connects them.

Body, as markdown:
  ## Through-line — what the user keeps returning to across these concepts
  ## Tensions — where the concepts pull apart
  ## Unstated — what's implied by their recurrence but never written
Reference constituent concepts with [[concept-slug]] wikilinks. Title: <= 6 words, Title Case.

Output STRICT JSON only:
{"page": {"slug":"kebab-case-<=60","title":"Theme Name","body":"markdown with [[wikilinks]]","tags":["..."]}}`;

function slugify(s: string): string {
  const out = (s || 'concept')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'concept';
}
function uniqueSlug(base: string, selfId: string): string {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = refForSlug(slug);
    if (!existing || existing === selfId) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

function relationForHeading(h: string): GraphConnectionType {
  const t = h.toLowerCase();
  if (/tension|contradict|disagree|conflict|versus|\bvs\b|trade-?off/.test(t)) {
    return 'contradicts';
  }
  if (/through-?line|evidence|support|reinforce|align|pattern/.test(t)) {
    return 'supports';
  }
  return 'references';
}
function parseWikilinks(
  body: string,
): Array<{ slug: string; type: GraphConnectionType }> {
  const out: Array<{ slug: string; type: GraphConnectionType }> = [];
  let rel: GraphConnectionType = 'references';
  const re = /\[\[([a-z0-9][a-z0-9-]*)\]\]/gi;
  for (const line of (body || '').split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      rel = relationForHeading(h[1]);
      continue;
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(line)) !== null) out.push({ slug: m[1], type: rel });
  }
  return out;
}

/** Concept↔concept edges (kind='concept'): explicit wikilinks + semantic. */
async function linkConceptNode(
  selfId: string,
  vector: number[],
  body: string,
): Promise<void> {
  const seen = new Set<string>();
  const createdAt = new Date().toISOString();
  const add = (target: string, type: GraphConnectionType, strength: number) => {
    if (!target || target === selfId || seen.has(target)) return;
    seen.add(target);
    const e = createGraphConnection({
      currentNoteId: selfId,
      relatedNoteId: target,
      direction: 'outgoing',
      type,
      strength,
      is_ai_suggestion: true,
      sourceIntegration: 'concept',
      createdAt,
    });
    upsertEdge({
      uniqueid: e.uniqueid,
      source_id: selfId,
      target_id: target,
      type: e.type,
      strength: e.strength,
      context: e.context,
      is_ai: 1,
      created_at: createdAt,
      kind: 'concept',
    });
  };
  for (const w of parseWikilinks(body)) {
    const t = refForSlug(w.slug);
    if (t) add(t, w.type, 0.9);
  }
  const hits = await searchLanceDB(vector, SEMANTIC_TOP_K, SEMANTIC_MAX_DISTANCE, {
    nodeTypes: [NODE_TYPE_CONCEPT, NODE_TYPE_THEME],
  });
  for (const h of hits) {
    if (typeof h.score === 'number' && h.score >= SEMANTIC_THRESHOLD) {
      add(h.uniqueid, 'references', h.score);
    }
  }
}

// --- concepts -------------------------------------------------------------
export async function runConceptPass(
  yieldFn: () => Promise<void>,
  budget: number,
): Promise<number> {
  const adj = adjacencyAboveStrength(SYNTH_STRENGTH_FLOOR, 'note');
  const communities = detectCommunities(adj);
  console.log(
    `[file-graph:concept-pass] note graph: ${adj.size} node(s) with edges ≥${SYNTH_STRENGTH_FLOOR}, ${communities.length} community(ies) ≥${MIN_GROUP} members (budget ${budget}). ${
      adj.size === 0
        ? 'No note↔note edges yet → concepts cannot form until the connection pass writes edges.'
        : ''
    }`,
  );
  let made = 0;

  for (const comm of communities) {
    if (made >= budget) break;
    const key = comm.members.slice().sort().join(',');
    const conceptId = uuidv5(`concept:${key}`, FILE_GRAPH_NAMESPACE);
    if (getConcept(conceptId)) continue; // this exact community already done
    if (isPageDeleted(conceptId)) continue; // user deleted it — never resurrect

    const docs: Array<{ id: string; title: string; path: string; text: string }> =
      [];
    for (const id of comm.members) {
      const d = await getGraphDoc(id);
      if (d?.text) docs.push({ id, title: d.title, path: d.path, text: d.text });
    }
    if (docs.length < MIN_GROUP) {
      console.log(
        `[file-graph:concept-pass] skip community of ${comm.members.length} — only ${docs.length} had doc text (<${MIN_GROUP})`,
      );
      continue;
    }

    const sources: GraphSource[] = docs.map((d) => ({
      uniqueid: d.id,
      path: d.path,
      excerpt: (d.text || '').slice(0, 200),
    }));
    const list = docs
      .map((d, i) => `[${i + 1}] ${d.title}\n${(d.text || '').slice(0, PARENT_BODY_CHARS)}`)
      .join('\n\n');
    const res = await runGraphLLM(
      CONCEPT_SYSTEM,
      `Cluster of ${docs.length} related notes:\n\n${list}\n\nWrite the concept page now; cite supporting notes inline as [n].`,
      120_000,
      'concept',
    );
    const page = res.json?.page;
    if (!res.ok || !page || !page.body || !page.title) {
      console.log(
        `[file-graph:concept-pass] community of ${docs.length} → no concept page (${
          !res.ok
            ? `LLM failed: ${res.error ?? 'unknown'}`
            : 'LLM returned {page:null} — notes share no single coherent idea'
        })`,
      );
      await yieldFn();
      continue;
    }

    const slug = uniqueSlug(slugify(page.slug || page.title), conceptId);
    const vec = await embedText(`${page.title}\n${page.body}`);
    if (!vec) {
      console.log('[file-graph:concept-pass] embed failed for new concept page');
      await yieldFn();
      continue;
    }
    console.log(
      `[file-graph:concept-pass] ✓ concept "${page.title}" from ${docs.length} notes`,
    );
    upsertConcept({
      id: conceptId,
      slug,
      title: String(page.title),
      body: String(page.body),
      sources_json: JSON.stringify(sources),
      status: 'live',
      cluster_id: key,
      updated_at: Date.now(),
    });
    setSlug(slug, conceptId);
    await syncVectorsToLanceDB([
      {
        uniqueid: conceptId,
        vector: vec,
        nodeType: NODE_TYPE_CONCEPT,
        relatedIds: comm.members,
      },
    ]);
    await linkConceptNode(conceptId, vec, String(page.body));
    made += 1;
    await yieldFn();
  }
  return made;
}

// --- themes ---------------------------------------------------------------
export async function runThemePass(
  yieldFn: () => Promise<void>,
  budget: number,
): Promise<number> {
  const adj = adjacencyAboveStrength(SYNTH_STRENGTH_FLOOR, 'concept');
  const communities = detectCommunities(adj);
  console.log(
    `[file-graph:theme-pass] concept graph: ${adj.size} node(s), ${communities.length} community(ies) ≥${MIN_GROUP} (need concept↔concept edges, which form once ≥${MIN_GROUP} concepts exist)`,
  );
  if (!communities.length) return 0;
  const conceptById = new Map(allConcepts().map((c) => [c.id, c]));
  let made = 0;

  for (const comm of communities) {
    if (made >= budget) break;
    const members = comm.members.filter((id) => conceptById.has(id));
    if (members.length < MIN_GROUP) continue;
    const key = members.slice().sort().join(',');
    const themeId = uuidv5(`theme:${key}`, FILE_GRAPH_NAMESPACE);
    if (isPageDeleted(themeId)) continue; // user deleted it — never resurrect

    const items = members.map((id) => {
      const c = conceptById.get(id)!;
      return `[[${c.slug}]] ${c.title}\n${(c.body || '').slice(0, PARENT_BODY_CHARS)}`;
    });
    const res = await runGraphLLM(
      THEME_SYSTEM,
      `These ${items.length} concept pages are densely linked. Name and synthesize the recurring THEME:\n\n${items.join(
        '\n\n',
      )}\n\nWrite the theme page now.`,
      120_000,
      'theme',
    );
    const page = res.json?.page;
    if (!res.ok || !page || !page.body || !page.title) {
      await yieldFn();
      continue;
    }

    const slug = uniqueSlug(slugify(page.slug || page.title), themeId);
    const vec = await embedText(`${page.title}\n${page.body}`);
    if (!vec) {
      await yieldFn();
      continue;
    }
    upsertTheme({
      id: themeId,
      slug,
      title: String(page.title),
      body: String(page.body),
      constituents_json: JSON.stringify(members),
      updated_at: Date.now(),
    });
    setSlug(slug, themeId);
    await syncVectorsToLanceDB([
      {
        uniqueid: themeId,
        vector: vec,
        nodeType: NODE_TYPE_THEME,
        relatedIds: members,
      },
    ]);
    // Theme → constituent concept edges (kind='concept') so it sits in the graph.
    const createdAt = new Date().toISOString();
    for (const cid of members) {
      const e = createGraphConnection({
        currentNoteId: themeId,
        relatedNoteId: cid,
        direction: 'outgoing',
        type: 'supports',
        strength: 1,
        is_ai_suggestion: true,
        sourceIntegration: 'theme',
        createdAt,
      });
      upsertEdge({
        uniqueid: e.uniqueid,
        source_id: themeId,
        target_id: cid,
        type: e.type,
        strength: 1,
        context: e.context,
        is_ai: 1,
        created_at: createdAt,
        kind: 'concept',
      });
    }
    made += 1;
    await yieldFn();
  }
  return made;
}
