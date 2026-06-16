/**
 * SQLite-backed graph store for the knowledge-graph engine (main process).
 *
 * Uses Node's built-in `node:sqlite` (Electron 41 bundles Node 24) — real
 * synchronous SQLite with NO native dependency and NO electron-rebuild, so none
 * of the better-sqlite3 ABI/Metal-rebuild risk applies.
 *
 * This is the single authoritative store on main, consolidating what used to be
 * a sprawl of JSON files:
 *   docs      — full text of each indexed note (engine's LLM input; main can't
 *               read the renderer's RxDB)
 *   edges     — the typed auto-connection graph (indexed both directions for
 *               O(1) traversal). Authoritative here; mirrored to RxDB note
 *               arrays only so the canvas renders them.
 *   concepts  — generated concept pages (full markdown body + sources)
 *   themes    — generated theme pages (body + constituents)
 *   slugs     — slug → concept/theme id (resolves [[wikilinks]])
 *   cursors   — small key/value engine state (clustering watermark, etc.)
 *
 * Vectors stay in LanceDB. The renderer queries this DB via the file-graph IPC
 * handlers.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// node:sqlite is a Node builtin — require lazily so webpack (electron-main
// target) externalizes it rather than trying to bundle it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
type DB = any;

let db: DB | null = null;

function dbPath(): string {
  return path.join(app.getPath('userData'), 'file-graph', 'graph.db');
}

/** Open (and migrate) the DB once. Synchronous; safe to call repeatedly. */
export function getGraphDb(): DB {
  if (db) return db;
  const dir = path.join(app.getPath('userData'), 'file-graph');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      parent_id TEXT PRIMARY KEY,
      title     TEXT,
      path      TEXT,
      text      TEXT
    );
    CREATE TABLE IF NOT EXISTS edges (
      uniqueid   TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL,
      target_id  TEXT NOT NULL,
      type       TEXT,
      strength   REAL,
      context    TEXT,
      is_ai      INTEGER DEFAULT 1,
      created_at TEXT,
      kind       TEXT DEFAULT 'note'
    );
    CREATE INDEX IF NOT EXISTS edges_src ON edges(source_id);
    CREATE INDEX IF NOT EXISTS edges_tgt ON edges(target_id);
    CREATE INDEX IF NOT EXISTS edges_kind ON edges(kind);
    CREATE TABLE IF NOT EXISTS concepts (
      id            TEXT PRIMARY KEY,
      slug          TEXT,
      title         TEXT,
      body          TEXT,
      sources_json  TEXT,
      status        TEXT DEFAULT 'live',
      cluster_id    TEXT,
      updated_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS themes (
      id                TEXT PRIMARY KEY,
      slug              TEXT,
      title             TEXT,
      body              TEXT,
      constituents_json TEXT,
      updated_at        INTEGER
    );
    CREATE TABLE IF NOT EXISTS slugs (
      slug TEXT PRIMARY KEY,
      ref_id TEXT
    );
    CREATE TABLE IF NOT EXISTS processed (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS deleted_pages (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS cursors (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

export function closeGraphDb(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

// --- docs (text store) ----------------------------------------------------
export interface GraphDoc {
  parentId: string;
  title: string;
  path: string;
  text: string;
}

export function putDoc(doc: GraphDoc): void {
  getGraphDb()
    .prepare(
      `INSERT INTO docs(parent_id,title,path,text) VALUES(?,?,?,?)
       ON CONFLICT(parent_id) DO UPDATE SET title=excluded.title, path=excluded.path, text=excluded.text`,
    )
    .run(doc.parentId, doc.title ?? '', doc.path ?? '', doc.text ?? '');
}

export function getDoc(parentId: string): GraphDoc | null {
  const r = getGraphDb()
    .prepare(
      `SELECT parent_id, title, path, text FROM docs WHERE parent_id = ?`,
    )
    .get(parentId) as any;
  if (!r) return null;
  return { parentId: r.parent_id, title: r.title, path: r.path, text: r.text };
}

export function hasDoc(parentId: string): boolean {
  return (
    getGraphDb()
      .prepare(`SELECT 1 FROM docs WHERE parent_id = ? LIMIT 1`)
      .get(parentId) != null
  );
}

export function allDocIds(): string[] {
  return (
    getGraphDb().prepare(`SELECT parent_id FROM docs`).all() as any[]
  ).map((r) => r.parent_id);
}

/**
 * Purge every engine trace of deleted notes: their doc text, their processed
 * marker (so a re-added file re-runs the connection pass), and their edges in
 * either direction. Without this, the file-index reconcile path would
 * faithfully "restore" deleted file notes from their leftover doc rows.
 */
export function deleteDocsByParentIds(parentIds: string[]): void {
  if (!parentIds.length) return;
  const db = getGraphDb();
  // Chunk to stay far below SQLITE_MAX_VARIABLE_NUMBER.
  for (let i = 0; i < parentIds.length; i += 500) {
    const part = parentIds.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');
    db.prepare(`DELETE FROM docs WHERE parent_id IN (${ph})`).run(...part);
    db.prepare(`DELETE FROM processed WHERE id IN (${ph})`).run(...part);
    db.prepare(
      `DELETE FROM edges WHERE kind = 'note' AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
    ).run(...part, ...part);
  }
}

/**
 * Delete specific note↔note edges by uniqueid (chunked to stay under SQLite's
 * variable cap). Used by the wikilink reconcile pass to drop edges whose
 * `[[link]]` was removed from the note — unlike deleteDocsByParentIds this
 * targets single edges, leaving the node's other edges (e.g. AI-suggested
 * ones) intact.
 */
export function deleteEdgesByIds(ids: string[]): void {
  if (!ids.length) return;
  const d = getGraphDb();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');
    d.prepare(
      `DELETE FROM edges WHERE kind = 'note' AND uniqueid IN (${ph})`,
    ).run(...part);
  }
}

// --- edges ----------------------------------------------------------------
export interface EdgeRow {
  uniqueid: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  context: string;
  is_ai: number;
  created_at: string;
  kind?: string; // 'note' (note↔note) | 'concept' (concept↔concept/theme)
}

export function upsertEdge(e: EdgeRow): void {
  getGraphDb()
    .prepare(
      `INSERT INTO edges(uniqueid,source_id,target_id,type,strength,context,is_ai,created_at,kind)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(uniqueid) DO UPDATE SET
         type=excluded.type, strength=excluded.strength, context=excluded.context`,
    )
    .run(
      e.uniqueid,
      e.source_id,
      e.target_id,
      e.type,
      e.strength,
      e.context ?? '',
      e.is_ai ?? 1,
      e.created_at ?? '',
      e.kind ?? 'note',
    );
}

export function outgoingEdges(sourceId: string): EdgeRow[] {
  return getGraphDb()
    .prepare(`SELECT * FROM edges WHERE source_id = ?`)
    .all(sourceId) as EdgeRow[];
}

/** Every concept↔concept / concept↔theme edge — feeds the Graph view in the
 *  renderer (the per-node `outgoingEdges` query can't return the whole graph). */
export function allConceptEdges(): EdgeRow[] {
  return getGraphDb()
    .prepare(`SELECT * FROM edges WHERE kind = 'concept'`)
    .all() as EdgeRow[];
}

export function connectedPair(a: string, b: string): boolean {
  return (
    getGraphDb()
      .prepare(
        `SELECT 1 FROM edges WHERE (source_id=? AND target_id=?) OR (source_id=? AND target_id=?) LIMIT 1`,
      )
      .get(a, b, b, a) != null
  );
}

/** All edges of a kind above a strength floor — for community detection. */
export function edgesAboveStrength(
  floor: number,
  kind = 'note',
): Array<{ source_id: string; target_id: string; strength: number }> {
  return getGraphDb()
    .prepare(
      `SELECT source_id, target_id, strength FROM edges WHERE strength >= ? AND kind = ?`,
    )
    .all(floor, kind) as any[];
}

export function edgeCountForSource(sourceId: string): number {
  const r = getGraphDb()
    .prepare(`SELECT COUNT(*) AS n FROM edges WHERE source_id = ?`)
    .get(sourceId) as any;
  return r?.n ?? 0;
}

// --- processed cursor -----------------------------------------------------
export function isProcessed(id: string): boolean {
  return (
    getGraphDb()
      .prepare(`SELECT 1 FROM processed WHERE id = ? LIMIT 1`)
      .get(id) != null
  );
}
export function markProcessed(id: string): void {
  getGraphDb().prepare(`INSERT OR IGNORE INTO processed(id) VALUES(?)`).run(id);
}
// Drop the processed marker so the next connection pass re-queries this record.
// Used when a note's body is edited (its vector/chunks changed, so its
// neighborhood + outgoing edges should be recomputed).
export function clearProcessed(id: string): void {
  getGraphDb().prepare(`DELETE FROM processed WHERE id = ?`).run(id);
}

// --- concepts -------------------------------------------------------------
export interface ConceptRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  sources_json: string;
  status: string;
  cluster_id: string;
  updated_at: number;
}
export function upsertConcept(c: ConceptRow): void {
  getGraphDb()
    .prepare(
      `INSERT INTO concepts(id,slug,title,body,sources_json,status,cluster_id,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         slug=excluded.slug, title=excluded.title, body=excluded.body,
         sources_json=excluded.sources_json, status=excluded.status,
         cluster_id=excluded.cluster_id, updated_at=excluded.updated_at`,
    )
    .run(
      c.id,
      c.slug,
      c.title,
      c.body,
      c.sources_json,
      c.status ?? 'live',
      c.cluster_id ?? '',
      c.updated_at,
    );
}
export function getConcept(id: string): ConceptRow | null {
  return (
    (getGraphDb()
      .prepare(`SELECT * FROM concepts WHERE id = ?`)
      .get(id) as ConceptRow) ?? null
  );
}
export function allConcepts(): ConceptRow[] {
  return getGraphDb().prepare(`SELECT * FROM concepts`).all() as ConceptRow[];
}

// --- themes ---------------------------------------------------------------
export interface ThemeRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  constituents_json: string;
  updated_at: number;
}
export function upsertTheme(t: ThemeRow): void {
  getGraphDb()
    .prepare(
      `INSERT INTO themes(id,slug,title,body,constituents_json,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         slug=excluded.slug, title=excluded.title, body=excluded.body,
         constituents_json=excluded.constituents_json, updated_at=excluded.updated_at`,
    )
    .run(t.id, t.slug, t.title, t.body, t.constituents_json, t.updated_at);
}
export function allThemes(): ThemeRow[] {
  return getGraphDb().prepare(`SELECT * FROM themes`).all() as ThemeRow[];
}
// Fetch one theme page by id (so file-graph:page can open themes, not just
// concepts — the Discoveries grid + Graph view click both route through it).
export function getTheme(id: string): ThemeRow | null {
  return (
    (getGraphDb()
      .prepare(`SELECT * FROM themes WHERE id = ?`)
      .get(id) as ThemeRow) ?? null
  );
}

// --- page deletion ----------------------------------------------------------
// Concept/theme ids are deterministic (uuidv5 of cluster membership), so a
// plain row delete would just get regenerated by the next synth pass. We
// tombstone the id in `deleted_pages` and the synth passes skip it forever.
export function isPageDeleted(id: string): boolean {
  return (
    getGraphDb()
      .prepare(`SELECT 1 FROM deleted_pages WHERE id = ? LIMIT 1`)
      .get(id) != null
  );
}

/**
 * Delete a concept OR theme page by id: tombstones the id, removes the row,
 * its slug mapping, and every concept-graph edge touching it. Returns true if
 * a concept/theme row actually existed.
 */
export function deleteGraphPage(id: string): boolean {
  const d = getGraphDb();
  const existed = Boolean(getConcept(id) || getTheme(id));
  d.prepare(`INSERT OR IGNORE INTO deleted_pages(id) VALUES(?)`).run(id);
  d.prepare(`DELETE FROM concepts WHERE id = ?`).run(id);
  d.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
  d.prepare(`DELETE FROM slugs WHERE ref_id = ?`).run(id);
  d.prepare(
    `DELETE FROM edges WHERE kind = 'concept' AND (source_id = ? OR target_id = ?)`,
  ).run(id, id);
  return existed;
}

// --- slug index -----------------------------------------------------------
export function setSlug(slug: string, refId: string): void {
  getGraphDb()
    .prepare(
      `INSERT INTO slugs(slug,ref_id) VALUES(?,?)
       ON CONFLICT(slug) DO UPDATE SET ref_id=excluded.ref_id`,
    )
    .run(slug, refId);
}
export function refForSlug(slug: string): string | undefined {
  const r = getGraphDb()
    .prepare(`SELECT ref_id FROM slugs WHERE slug = ?`)
    .get(slug) as any;
  return r?.ref_id;
}
export function slugIndexMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of getGraphDb()
    .prepare(`SELECT slug, ref_id FROM slugs`)
    .all() as any[]) {
    out[r.slug] = r.ref_id;
  }
  return out;
}
