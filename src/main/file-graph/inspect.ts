/**
 * File-graph inspector — a boot-time (and on-demand) quality report on what the
 * LOCAL indexing + knowledge-graph engine has actually ingested and connected.
 *
 * Why this exists: local-mode generation is slow, but the local model is still
 * the one wiring the corpus together (auto-connections → concepts → themes).
 * This module reads the authoritative stores directly and prints a legible
 * report so we can eyeball the QUALITY of that work without spelunking SQLite:
 *   - docs:      how much text was ingested, length distribution, WHERE it came
 *                from (folder roots — surfaces "we're indexing node_modules")
 *   - LanceDB:   vector counts by nodeType + the live dimension
 *   - processed: connection-pass progress (processed vs total)
 *   - edges:     auto-connections by kind/type, strength spread, sample captions
 *   - concepts/themes: synthesized pages with samples
 *   - flags:     heuristic quality warnings (junk paths, 0-edge stall, dim drift)
 *
 * It writes the same report to `<userData>/file-graph/inspect-report.md` and
 * logs a console summary. Pure read-only — never mutates the graph.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { getGraphDb } from './graphDb';
import { getLanceDBStats, searchLanceDB } from '../utils/vector-db/vector-db';
import { embedText } from './embed';
import {
  MIN_CONTENT_LENGTH,
  CONNECTION_STRENGTH_FLOOR,
  SYNTH_STRENGTH_FLOOR,
  VECTOR_RECALL_MAX_DISTANCE,
  VECTOR_RECALL_TOP_K,
} from './constants';

// Path roots we never want to be indexing — code/vendored junk, not the user's
// knowledge. Used only to flag suspicious ingestion in the report.
const JUNK_PATH_MARKERS = [
  'node_modules',
  '/venv/',
  'site-packages',
  'dist-packages',
  '.git/',
  'DerivedData',
  'Pods/',
  '/build/',
  '/.next/',
  '/target/',
  'vendor/',
];

interface Section {
  title: string;
  lines: string[];
}

function pct(n: number, total: number): string {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

/** Gather every section of the report as structured text. */
async function gather(): Promise<{ sections: Section[]; summary: string }> {
  const db = getGraphDb();
  const sections: Section[] = [];

  const q = (sql: string, ...args: any[]): any[] =>
    db.prepare(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]): any =>
    db.prepare(sql).get(...args);

  // --- DOCS (ingested text) ------------------------------------------------
  const docCount = one('SELECT COUNT(*) n FROM docs')?.n ?? 0;
  const docLines: string[] = [`Total ingested docs: ${docCount}`];

  if (docCount) {
    const dist = q(`
      SELECT CASE
        WHEN length(text)=0 THEN '0 (empty)'
        WHEN length(text)<${MIN_CONTENT_LENGTH} THEN '1-${MIN_CONTENT_LENGTH - 1} (skipped: too short)'
        WHEN length(text)<200 THEN '20-199'
        WHEN length(text)<1000 THEN '200-999'
        WHEN length(text)<20000 THEN '1000-19999'
        ELSE '20000 (capped)'
      END bucket, COUNT(*) n
      FROM docs GROUP BY bucket ORDER BY MIN(length(text))`);
    docLines.push('', 'Text-length distribution:');
    for (const r of dist) {
      docLines.push(`  ${r.bucket.padEnd(34)} ${r.n}  (${pct(r.n, docCount)})`);
    }

    // Folder roots: collapse each path to its top 4 segments so we can see
    // WHERE the corpus comes from (and whether it's junk).
    const roots = new Map<string, number>();
    let junkCount = 0;
    for (const r of q('SELECT path FROM docs')) {
      const p: string = r.path || '(no path)';
      if (JUNK_PATH_MARKERS.some((m) => p.includes(m))) junkCount += 1;
      const root = p.split('/').slice(0, 6).join('/') || '(no path)';
      roots.set(root, (roots.get(root) ?? 0) + 1);
    }
    const topRoots = [...roots.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    docLines.push('', 'Top folder roots (where the data came from):');
    for (const [root, n] of topRoots) {
      docLines.push(`  ${String(n).padStart(6)}  ${root}`);
    }
    docLines.push(
      '',
      `Docs under junk paths (node_modules / venv / build / .git ...): ${junkCount}  (${pct(junkCount, docCount)})`,
    );

    const samples = q(
      'SELECT title, path, length(text) tlen FROM docs ORDER BY RANDOM() LIMIT 8',
    );
    docLines.push('', 'Random sample docs (title | len | path):');
    for (const r of samples) {
      docLines.push(
        `  • ${(r.title || '(untitled)').slice(0, 36).padEnd(36)} ${String(r.tlen).padStart(6)}  ${(r.path || '').slice(-70)}`,
      );
    }
  }
  sections.push({ title: '1. INGESTED DOCS (text store)', lines: docLines });

  // --- LANCEDB (vectors) ---------------------------------------------------
  const lance = await getLanceDBStats();
  const lanceLines: string[] = [];
  if (!lance.ready) {
    lanceLines.push('LanceDB not initialized yet (no vector store open).');
  } else {
    lanceLines.push(`Total vectors: ${lance.total}`);
    lanceLines.push(`Live vector dimension: ${lance.dim ?? 'unknown'}`);
    const tallyBase = lance.sampled || lance.total;
    lanceLines.push(
      '',
      lance.sampled
        ? `By nodeType (sampled from ${lance.sampled} of ${lance.total} rows):`
        : 'By nodeType:',
    );
    for (const [t, n] of Object.entries(lance.byNodeType)) {
      lanceLines.push(`  ${t.padEnd(12)} ${n}  (${pct(n, tallyBase)})`);
    }
    // Strict parent-note searches still need real note vectors. The connection
    // pass can also resolve note_body chunks back to parents, but zero parent
    // rows means some older recall probes and direct note lookups will fail.
    if ((lance.byNodeType['note'] ?? 0) === 0) {
      lanceLines.push(
        '',
        "  ⚠ 0 'note' vectors in the sample — strict parent-note recall will",
        '    find 0 candidates regardless of corpus size. The connection pass',
        '    can still use note_body chunks only when relatedIds resolve.',
      );
    }
  }
  sections.push({ title: '2. VECTOR STORE (LanceDB)', lines: lanceLines });

  // --- CONNECTION-PASS PROGRESS -------------------------------------------
  const processed = one('SELECT COUNT(*) n FROM processed')?.n ?? 0;
  const progLines = [
    `Docs processed by the connection pass: ${processed} / ${docCount}  (${pct(processed, docCount)})`,
    `Remaining unprocessed: ${docCount - processed}`,
    '',
    `Connection pass runs 3 docs/tick, ~60s/tick, recall-gated — so a large`,
    `corpus drains slowly. A high "remaining" is expected early; a STALLED`,
    `processed count across runs means the LLM provider isn't available.`,
  ];
  sections.push({ title: '3. CONNECTION PROGRESS', lines: progLines });

  // --- EDGES (auto-connections) -------------------------------------------
  const edgeCount = one('SELECT COUNT(*) n FROM edges')?.n ?? 0;
  const edgeLines: string[] = [`Total edges: ${edgeCount}`];
  if (edgeCount) {
    const byKindType = q(`
      SELECT kind, type, COUNT(*) n, ROUND(AVG(strength),3) avg_s,
             ROUND(MIN(strength),2) min_s, ROUND(MAX(strength),2) max_s
      FROM edges GROUP BY kind, type ORDER BY n DESC`);
    edgeLines.push('', 'By kind / type (count | avg | min–max strength):');
    for (const r of byKindType) {
      edgeLines.push(
        `  ${String(r.kind || 'note').padEnd(9)} ${String(r.type).padEnd(12)} ${String(r.n).padStart(5)}   avg ${r.avg_s}  (${r.min_s}–${r.max_s})`,
      );
    }
    // Sample edge captions — the human-readable "why" of each connection.
    const sampleEdges = q(`
      SELECT e.type, e.strength, e.context,
             ds.title stitle, dt.title ttitle
      FROM edges e
      LEFT JOIN docs ds ON ds.parent_id = e.source_id
      LEFT JOIN docs dt ON dt.parent_id = e.target_id
      ORDER BY e.strength DESC LIMIT 12`);
    edgeLines.push('', 'Strongest connections (the quality signal):');
    for (const r of sampleEdges) {
      edgeLines.push(
        `  [${r.type} ${Number(r.strength).toFixed(2)}] ${(r.stitle || '?').slice(0, 24)} → ${(r.ttitle || '?').slice(0, 24)}`,
      );
      edgeLines.push(`       ctx: ${(r.context || '(none)').slice(0, 100)}`);
    }
  } else {
    edgeLines.push(
      '',
      'No auto-connections yet. If docs are processed but edges=0, the local',
      'model is rejecting every candidate pair (classifier → "none"), the',
      'candidates are junk (e.g. license files), or no provider ran.',
    );
  }
  sections.push({ title: '4. AUTO-CONNECTIONS (edges)', lines: edgeLines });

  // --- CONCEPTS ------------------------------------------------------------
  const conceptCount = one('SELECT COUNT(*) n FROM concepts')?.n ?? 0;
  const conLines: string[] = [`Total concept pages: ${conceptCount}`];
  if (conceptCount) {
    const cs = q(
      'SELECT title, slug, sources_json, length(body) blen FROM concepts ORDER BY updated_at DESC LIMIT 10',
    );
    conLines.push('', 'Recent concepts (title | #sources | body len):');
    for (const r of cs) {
      let nsrc = 0;
      try {
        nsrc = (JSON.parse(r.sources_json || '[]') as any[]).length;
      } catch {
        /* ignore */
      }
      conLines.push(
        `  • ${(r.title || r.slug).slice(0, 44).padEnd(44)} ${String(nsrc).padStart(3)} src  ${r.blen}ch`,
      );
    }
  }
  sections.push({ title: '5. CONCEPT PAGES (synthesized)', lines: conLines });

  // --- THEMES --------------------------------------------------------------
  const themeCount = one('SELECT COUNT(*) n FROM themes')?.n ?? 0;
  const thLines: string[] = [`Total theme pages: ${themeCount}`];
  if (themeCount) {
    const ts = q(
      'SELECT title, constituents_json FROM themes ORDER BY updated_at DESC LIMIT 10',
    );
    thLines.push('', 'Themes (title | #concepts):');
    for (const r of ts) {
      let nc = 0;
      try {
        nc = (JSON.parse(r.constituents_json || '[]') as any[]).length;
      } catch {
        /* ignore */
      }
      thLines.push(`  • ${(r.title || '?').slice(0, 50).padEnd(50)} ${nc} concepts`);
    }
  }
  sections.push({ title: '6. THEME PAGES (synthesized)', lines: thLines });

  // --- LIVE SEARCH PROBE ---------------------------------------------------
  // This probe embeds a few random stored docs and runs search three ways:
  //   (a) strict parent-note search (nodeTypes:['note'] + maxDist 0.55)
  //   (b) default recall/connection search (exclude only graph nodes)
  //   (c) strict parent-note search with a WIDE distance (1.9)
  // Reading the three hit-counts together tells us whether it's the embedder
  // (all zero, incl. wide), the distance threshold (zero until wide), or a
  // parent-note vs chunk/nodeType filter issue (strict note zero, default nonzero).
  const probeLines: string[] = [];
  const probeResult = { ran: 0, embedNull: 0, hitsA: 0, hitsB: 0, hitsC: 0 };
  try {
    const probeDocs = q(
      `SELECT parent_id, title, text FROM docs WHERE length(text) >= 200 ORDER BY RANDOM() LIMIT 4`,
    );
    if (!probeDocs.length) {
      probeLines.push('No docs with ≥200 chars to probe.');
    }
    for (const d of probeDocs) {
      const label = (d.title || d.parent_id).slice(0, 30);
      const queryText = `${d.title || ''}\n${(d.text || '').slice(0, 300)}`.trim();
      // eslint-disable-next-line no-await-in-loop
      const vec = await embedText(queryText);
      probeResult.ran += 1;
      if (!vec) {
        probeResult.embedNull += 1;
        probeLines.push(`  • "${label}" → embed returned NULL (embedder down)`);
        // eslint-disable-next-line no-continue
        continue;
      }
      // (a) strict parent-note search
      // eslint-disable-next-line no-await-in-loop
      const a = await searchLanceDB(vec, VECTOR_RECALL_TOP_K, VECTOR_RECALL_MAX_DISTANCE, {
        nodeTypes: ['note'],
      });
      // (b) default recall/connection search
      // eslint-disable-next-line no-await-in-loop
      const b = await searchLanceDB(vec, VECTOR_RECALL_TOP_K, VECTOR_RECALL_MAX_DISTANCE);
      // (c) filtered but wide distance
      // eslint-disable-next-line no-await-in-loop
      const c = await searchLanceDB(vec, VECTOR_RECALL_TOP_K, 1.9, {
        nodeTypes: ['note'],
      });
      probeResult.hitsA += a.length;
      probeResult.hitsB += b.length;
      probeResult.hitsC += c.length;
      const top = a[0] || b[0] || c[0];
      const topDist = top ? (1 - (top.score ?? 0)).toFixed(3) : 'n/a';
      // Decisive: what nodeType are the default hits? If they're mostly
      // note_body, the connection pass can still resolve them through
      // relatedIds; strict parent-only probes are expected to look weaker.
      const btypes = new Map<string, number>();
      for (const h of b) {
        const t = h?.nodeType ?? '(null)';
        btypes.set(t, (btypes.get(t) ?? 0) + 1);
      }
      const btypeStr = [...btypes.entries()]
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');
      probeLines.push(
        `  • "${label}" dim=${vec.length} → a(note,≤0.55)=${a.length}  b(any,≤0.55)=${b.length}  c(note,≤1.9)=${c.length}  nearest_dist=${topDist}  b.nodeTypes={${btypeStr}}`,
      );
    }
    // Interpretation line — turns the three counts into a verdict.
    if (probeResult.ran) {
      if (probeResult.embedNull === probeResult.ran) {
        probeLines.push('', 'VERDICT: embedder is down — every query embedded to null.');
      } else if (probeResult.hitsA > 0) {
        probeLines.push('', 'VERDICT: search WORKS here — the empty graph is likely the markProcessed-on-failure bug burning records during an earlier embedder outage.');
      } else if (probeResult.hitsB > 0) {
        probeLines.push('', "VERDICT: strict parent-note recall returned 0 while default recall returned hits — the corpus is searchable, but parent-note filtering is weaker than chunk recall.");
      } else if (probeResult.hitsC > 0) {
        probeLines.push('', 'VERDICT: the DISTANCE THRESHOLD (0.55) is too tight for this embedding space — widen VECTOR_RECALL_MAX_DISTANCE.');
      } else {
        probeLines.push('', 'VERDICT: search returns 0 even unfiltered at wide distance — the vector index/table is broken (fragmentation / dim mismatch / needs compaction).');
      }
    }
  } catch (e: any) {
    probeLines.push(`probe failed: ${e?.message ?? e}`);
  }
  sections.push({ title: '7. LIVE SEARCH PROBE (why 0 hits?)', lines: probeLines });

  // --- THRESHOLDS IN EFFECT ------------------------------------------------
  sections.push({
    title: '8. THRESHOLDS IN EFFECT',
    lines: [
      `MIN_CONTENT_LENGTH        ${MIN_CONTENT_LENGTH} chars (docs shorter are skipped)`,
      `VECTOR_RECALL_MAX_DISTANCE ${VECTOR_RECALL_MAX_DISTANCE} (candidate must be ≥ ${(1 - VECTOR_RECALL_MAX_DISTANCE).toFixed(2)} cosine sim)`,
      `CONNECTION_STRENGTH_FLOOR ${CONNECTION_STRENGTH_FLOOR} (edges below this are dropped)`,
      `SYNTH_STRENGTH_FLOOR      ${SYNTH_STRENGTH_FLOOR} (edge strength needed to cluster into concepts)`,
    ],
  });

  // --- QUALITY FLAGS -------------------------------------------------------
  const flags: string[] = [];
  // Re-derive a couple counts cheaply for the flag logic.
  const junkRow = one(
    `SELECT COUNT(*) n FROM docs WHERE ${JUNK_PATH_MARKERS.map(
      (m) => `path LIKE '%${m.replace(/'/g, "''")}%'`,
    ).join(' OR ')}`,
  );
  const junk = junkRow?.n ?? 0;
  if (docCount && junk / docCount > 0.2) {
    flags.push(
      `⚠ ${pct(junk, docCount)} of ingested docs are under junk paths (node_modules/venv/build). The indexer is eating code dependencies, not knowledge. Tighten the file-index walk to skip these roots.`,
    );
  }
  if (processed > 50 && edgeCount === 0) {
    flags.push(
      `⚠ ${processed} docs processed but 0 edges. See the LIVE SEARCH PROBE verdict above for the precise cause (embedder / nodeType filter / distance / table).`,
    );
  }
  // Surface the probe's machine verdict as a flag so the one-glance section
  // names the root cause without reading the probe table.
  if (probeResult.ran) {
    if (probeResult.embedNull === probeResult.ran) {
      flags.push('⚠ SEARCH PROBE: embedder down (all queries → null vector).');
    } else if (probeResult.hitsA === 0 && probeResult.hitsB === 0 && probeResult.hitsC === 0) {
      flags.push('⚠ SEARCH PROBE: 0 hits even unfiltered at max distance — the vector table is effectively unsearchable (fragmentation / dim / compaction).');
    } else if (probeResult.hitsA === 0 && probeResult.hitsB > 0) {
      flags.push("⚠ SEARCH PROBE: strict parent-note recall returns 0 while default recall returns hits — chunk recall works, parent-note filtering is weak.");
    } else if (probeResult.hitsA === 0 && probeResult.hitsC > 0) {
      flags.push('⚠ SEARCH PROBE: distance floor 0.55 too tight — widen VECTOR_RECALL_MAX_DISTANCE.');
    } else if (probeResult.hitsA > 0) {
      flags.push('✓ SEARCH PROBE: search works now — empty graph is the markProcessed-on-transient-failure bug (connections.ts:192). Records were consumed during an earlier embedder outage.');
    }
  }
  if (lance.ready && lance.dim && lance.dim !== 512) {
    flags.push(
      `⚠ Live vector dim is ${lance.dim}, expected 512 (EmbeddingGemma Matryoshka). A reindex may be pending.`,
    );
  }
  if (lance.ready && (lance.byNodeType['note'] ?? 0) === 0 && docCount > 0) {
    flags.push(
      `⚠ ${docCount} docs in the text store but 0 'note' vectors in LanceDB — vectors and text are out of sync; connection search will find nothing.`,
    );
  }
  if (docCount === 0) {
    flags.push('⚠ Nothing ingested yet — no local files have been indexed.');
  }
  if (!flags.length) flags.push('✓ No obvious quality issues detected.');
  sections.push({ title: '9. QUALITY FLAGS', lines: flags });

  const summary =
    `docs=${docCount} processed=${processed} edges=${edgeCount} ` +
    `concepts=${conceptCount} themes=${themeCount} ` +
    `vectors=${lance.ready ? lance.total : 'n/a'} dim=${lance.dim ?? '?'} junk=${junk}`;

  return { sections, summary };
}

function render(sections: Section[], summary: string, ts: string): string {
  const out: string[] = [];
  out.push('═'.repeat(78));
  out.push(' FILE-GRAPH INSPECTION REPORT');
  out.push(` generated ${ts}`);
  out.push(` ${summary}`);
  out.push('═'.repeat(78));
  for (const s of sections) {
    out.push('');
    out.push(`── ${s.title} ${'─'.repeat(Math.max(0, 72 - s.title.length))}`);
    for (const l of s.lines) out.push(l);
  }
  out.push('');
  out.push('═'.repeat(78));
  return out.join('\n');
}

/**
 * Build the report, log a summary line + the full report to the console, and
 * write it to `<userData>/file-graph/inspect-report.md`. Returns the report
 * text. Safe to call anytime; swallows its own errors so boot never breaks.
 *
 * @param tsLabel  human timestamp (passed in — main can't rely on Date here in
 *                 some sandboxes; falls back to a fixed label if absent).
 */
export async function inspectFileGraph(tsLabel?: string): Promise<string> {
  const ts = tsLabel || new Date().toISOString();
  try {
    const { sections, summary } = await gather();
    const report = render(sections, summary, ts);
    // Concise one-liner first (greppable), then the full report.
    console.log(`[file-graph:inspect] ${summary}`);
    console.log(report);
    try {
      const dir = path.join(app.getPath('userData'), 'file-graph');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'inspect-report.md'), report, 'utf8');
      console.log(
        `[file-graph:inspect] report written to ${path.join(dir, 'inspect-report.md')}`,
      );
    } catch (e: any) {
      console.warn('[file-graph:inspect] could not write report file:', e?.message ?? e);
    }
    return report;
  } catch (e: any) {
    console.warn('[file-graph:inspect] failed:', e?.message ?? e);
    return `inspect failed: ${e?.message ?? e}`;
  }
}
