/**
 * Canvases repo (local-first "projects") — runs inside the db worker_thread
 * (plain CJS). Each row is one canvas, stored as the EXACT cloud ResearchCanvas
 * doc shape (canvas_id, name, description, card_theme_color, card_emoji,
 * node_count, created_at, updated_at, canvas_data, saved_view_data) plus a
 * `uniqueid` mirror of canvas_id (the repo layer's pk convention).
 *
 * The doc's saved_view_data arrives already STRIPPED of heavy per-node fields
 * (file bytes / extracted text / vectors — see
 * src/utils/canvas/local-canvas-store.ts), so docs stay small-ish; recents and
 * title search still never parse docs at all — they read the derived scalar
 * columns + `preview_nodes` (small JSON array of {id,type,title}) computed
 * once per write.
 */
const {
  IN_CHUNK,
  chunk,
  docColumn,
  parseDoc,
  placeholders,
  requireUniqueid,
  stripRxInternals,
  withTransaction,
} = require('./helpers');

// File-note title prefixes (mirror src/utils/storage/helpers.ts — the worker
// is plain CJS and can't import the TS module). Used to humanize preview
// titles the same way buildNoteTitles does for the cloud description.
const IMAGE_NOTE_PREFIX = '<IMAGE-NOTE:> ';
const DOC_NOTE_PREFIX = '<DOC-NOTE:> ';
const PREVIEW_NODE_LIMIT = 8;

/** Clean a raw note title for card preview display (file prefixes → labels). */
function previewTitle(raw) {
  const title = typeof raw === 'string' ? raw : '';
  if (title.startsWith(IMAGE_NOTE_PREFIX)) return 'Image Note';
  if (title.startsWith(DOC_NOTE_PREFIX)) return 'Document Note';
  return title;
}

/**
 * Derive the preview_nodes column: prefer a pre-derived doc.preview_nodes
 * (cloud-adopted rows carry the backend's own preview list), else take the
 * first few note nodes out of saved_view_data.
 */
function derivePreviewNodes(doc) {
  if (Array.isArray(doc.preview_nodes)) {
    return doc.preview_nodes.slice(0, PREVIEW_NODE_LIMIT).map((p) => ({
      id: String((p && p.id) || ''),
      type: (p && p.type) || null,
      title: previewTitle(p && p.title),
    }));
  }
  const nodes =
    doc.saved_view_data && Array.isArray(doc.saved_view_data.nodes)
      ? doc.saved_view_data.nodes
      : [];
  const out = [];
  for (const node of nodes) {
    if (out.length >= PREVIEW_NODE_LIMIT) break;
    const note = node && node.data && node.data.note;
    if (!note) continue; // freehand strokes etc. have no card title
    const rxdb = note.rxdbData || {};
    out.push({
      id: String(node.id || note.uniqueid || ''),
      type: note.type || rxdb.noteType || null,
      title: previewTitle(rxdb.title),
    });
  }
  return out;
}

function buildCanvasesRepo(db) {
  const upsertStmt = db.prepare(
    `INSERT INTO canvases(uniqueid,name,description,node_count,card_theme_color,card_emoji,created_at,updated_at,preview_nodes,doc)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uniqueid) DO UPDATE SET
       name=excluded.name, description=excluded.description,
       node_count=excluded.node_count, card_theme_color=excluded.card_theme_color,
       card_emoji=excluded.card_emoji, created_at=excluded.created_at,
       updated_at=excluded.updated_at, preview_nodes=excluded.preview_nodes,
       doc=excluded.doc`,
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO canvases(uniqueid,name,description,node_count,card_theme_color,card_emoji,created_at,updated_at,preview_nodes,doc)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  );
  const findOneStmt = db.prepare(`SELECT doc FROM canvases WHERE uniqueid = ?`);

  const META_COLS =
    'uniqueid,name,description,node_count,card_theme_color,card_emoji,created_at,updated_at,preview_nodes';

  const str = (v) => (typeof v === 'string' ? v : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  /** Parse once, sync uniqueid<->canvas_id, derive every index column. */
  const prepare = (docStr) => {
    const doc = parseDoc(docStr, 'canvases');
    let dirty = stripRxInternals(doc);
    // canvas_id is the cloud pk; uniqueid is the repo pk — keep both present
    // and identical so docs round-trip to either layer unchanged.
    if (!doc.uniqueid && typeof doc.canvas_id === 'string') {
      doc.uniqueid = doc.canvas_id;
      dirty = true;
    }
    if (!doc.canvas_id && typeof doc.uniqueid === 'string') {
      doc.canvas_id = doc.uniqueid;
      dirty = true;
    }
    const uniqueid = requireUniqueid(doc, 'canvases');
    if (dirty) docStr = JSON.stringify(doc);
    return {
      uniqueid,
      vals: [
        uniqueid,
        str(doc.name) || '',
        str(doc.description),
        num(doc.node_count),
        str(doc.card_theme_color),
        str(doc.card_emoji),
        str(doc.created_at),
        str(doc.updated_at),
        JSON.stringify(derivePreviewNodes(doc)),
        docStr,
      ],
    };
  };

  return {
    findOne(id) {
      const row = findOneStmt.get(id);
      return row ? row.doc : null;
    },

    findByIds(ids) {
      const out = [];
      for (const part of chunk(ids, IN_CHUNK)) {
        out.push(
          ...docColumn(
            db
              .prepare(
                `SELECT doc FROM canvases WHERE uniqueid IN (${placeholders(
                  part.length,
                )})`,
              )
              .all(...part),
          ),
        );
      }
      return out;
    },

    /**
     * Scalar columns only (no doc parse) — for search-hit hydration and any
     * caller that just paints a card. preview_nodes is a JSON string.
     */
    findMetaByIds(ids) {
      const out = [];
      for (const part of chunk(ids, IN_CHUNK)) {
        out.push(
          ...db
            .prepare(
              `SELECT ${META_COLS} FROM canvases WHERE uniqueid IN (${placeholders(
                part.length,
              )})`,
            )
            .all(...part),
        );
      }
      return out;
    },

    /** Most recently updated first — compact rows + total for pagination. */
    recent(opts) {
      const limit = Math.max(1, Math.floor((opts && opts.limit) || 10));
      const skip = Math.max(0, Math.floor((opts && opts.skip) || 0));
      const records = db
        .prepare(
          `SELECT ${META_COLS} FROM canvases ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, skip);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM canvases`).get().n;
      return { records, total };
    },

    /**
     * Case-insensitive substring over name OR description, newest first —
     * mirrors the cloud /canvas/search keyword semantics.
     */
    searchByTitle(opts) {
      const query = String((opts && opts.query) || '').trim();
      if (!query) return [];
      const limit = Math.max(1, Math.floor((opts && opts.limit) || 30));
      return db
        .prepare(
          `SELECT ${META_COLS} FROM canvases
           WHERE instr(lower(name), lower(?)) > 0
              OR (description IS NOT NULL AND instr(lower(description), lower(?)) > 0)
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(query, query, limit);
    },

    upsert(docStr) {
      const p = prepare(docStr);
      upsertStmt.run(...p.vals);
      return {
        data: null,
        change: { collection: 'canvases', op: 'upsert', ids: [p.uniqueid] },
      };
    },

    /** $set-merge a partial into the stored doc; null when no row exists. */
    patch(id, partialStr) {
      return withTransaction(db, () => {
        const row = findOneStmt.get(id);
        if (!row) return { data: null };
        const partial = parseDoc(partialStr, 'canvases.patch');
        const existing = JSON.parse(row.doc);
        const merged = { ...existing, ...partial };
        merged.uniqueid = existing.uniqueid;
        merged.canvas_id = existing.canvas_id || existing.uniqueid;
        const p = prepare(JSON.stringify(merged));
        upsertStmt.run(...p.vals);
        return {
          data: p.vals[p.vals.length - 1],
          change: { collection: 'canvases', op: 'upsert', ids: [p.uniqueid] },
        };
      });
    },

    bulkUpsert(docStrs) {
      const prepared = docStrs.map(prepare);
      withTransaction(db, () => {
        for (const p of prepared) upsertStmt.run(...p.vals);
      });
      return {
        data: { count: prepared.length },
        change: {
          collection: 'canvases',
          op: 'upsert',
          ids: prepared.map((p) => p.uniqueid),
        },
      };
    },

    /** Migration path — never clobbers rows the new write path already owns. */
    bulkInsertIgnore(docStrs) {
      const prepared = docStrs.map(prepare);
      let inserted = 0;
      withTransaction(db, () => {
        for (const p of prepared) {
          if (insertIgnoreStmt.run(...p.vals).changes > 0) inserted += 1;
        }
      });
      return { data: { inserted } };
    },

    bulkRemove(ids) {
      withTransaction(db, () => {
        for (const part of chunk(ids, IN_CHUNK)) {
          db.prepare(
            `DELETE FROM canvases WHERE uniqueid IN (${placeholders(
              part.length,
            )})`,
          ).run(...part);
        }
      });
      return {
        data: null,
        change: { collection: 'canvases', op: 'delete', ids },
      };
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM canvases`).get().n;
    },
  };
}

module.exports = { buildCanvasesRepo };
