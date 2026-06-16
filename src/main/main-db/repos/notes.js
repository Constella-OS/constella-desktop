/**
 * Notes repo — runs inside the db worker_thread (plain CJS, see helpers.js).
 *
 * Storage model: the full note doc (NoteRxdbData.toObject() shape, including
 * every AI subtype field — aiResult / aiChatOutput / aiChildNodes / shape /
 * sourceEdges / groupSize / graphSources) is stored VERBATIM as a JSON string
 * in `notes.doc`. The scalar columns + the `note_tags` junction are derived
 * projections rebuilt on every write and exist only so queries are indexed —
 * never the source of truth.
 *
 * Vector strip: LanceDB owns all vector search; the `vector` field on docs is
 * write-only ballast (would add GBs at 500k notes), so writes persist it as
 * `[]`. Flip PERSIST_VECTORS to revert.
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

const PERSIST_VECTORS = false;

/**
 * Parse a doc string once: derive the index columns + tag ids, strip the
 * vector, and re-serialize. This is the only place a note doc is parsed on
 * the write path.
 */
function prepareNote(docStr) {
  const doc = parseDoc(docStr, 'notes');
  const uniqueid = requireUniqueid(doc, 'notes');
  const stripped = stripRxInternals(doc);
  const stripVector =
    !PERSIST_VECTORS && Array.isArray(doc.vector) && doc.vector.length > 0;
  if (stripVector) doc.vector = [];
  if (stripped || stripVector) docStr = JSON.stringify(doc);
  const tagIds = Array.isArray(doc.tags)
    ? [
        ...new Set(
          doc.tags
            .map((t) => t && t.uniqueid)
            .filter((id) => typeof id === 'string' && id.length > 0),
        ),
      ]
    : [];
  return {
    uniqueid,
    title: typeof doc.title === 'string' ? doc.title : '',
    noteType: typeof doc.noteType === 'string' ? doc.noteType : null,
    integrationName:
      typeof doc.integrationName === 'string' ? doc.integrationName : null,
    subtype: typeof doc.subtype === 'string' ? doc.subtype : null,
    created: typeof doc.created === 'number' ? doc.created : null,
    lastModified: typeof doc.lastModified === 'number' ? doc.lastModified : null,
    tagIds,
    docStr,
  };
}

function buildNotesRepo(db) {
  const upsertStmt = db.prepare(
    `INSERT INTO notes(uniqueid,title,note_type,integration_name,subtype,created,last_modified,doc)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(uniqueid) DO UPDATE SET
       title=excluded.title, note_type=excluded.note_type,
       integration_name=excluded.integration_name, subtype=excluded.subtype,
       created=excluded.created, last_modified=excluded.last_modified,
       doc=excluded.doc`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO notes(uniqueid,title,note_type,integration_name,subtype,created,last_modified,doc)
     VALUES(?,?,?,?,?,?,?,?)`,
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO notes(uniqueid,title,note_type,integration_name,subtype,created,last_modified,doc)
     VALUES(?,?,?,?,?,?,?,?)`,
  );
  const clearTagsStmt = db.prepare(`DELETE FROM note_tags WHERE note_id = ?`);
  const insertTagStmt = db.prepare(
    `INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES(?,?)`,
  );
  const findOneStmt = db.prepare(`SELECT doc FROM notes WHERE uniqueid = ?`);

  // Write the derived note_tags rows for one note (inside the caller's txn).
  const writeTagJunction = (n) => {
    clearTagsStmt.run(n.uniqueid);
    for (const tagId of n.tagIds) insertTagStmt.run(n.uniqueid, tagId);
  };

  const runUpsert = (stmt, n) =>
    stmt.run(
      n.uniqueid,
      n.title,
      n.noteType,
      n.integrationName,
      n.subtype,
      n.created,
      n.lastModified,
      n.docStr,
    );

  return {
    findByIds(ids) {
      const out = [];
      for (const part of chunk(ids, IN_CHUNK)) {
        const rows = db
          .prepare(
            `SELECT doc FROM notes WHERE uniqueid IN (${placeholders(part.length)})`,
          )
          .all(...part);
        out.push(...docColumn(rows));
      }
      return out;
    },

    findOne(id) {
      const row = findOneStmt.get(id);
      return row ? row.doc : null;
    },

    /**
     * Mirrors rxdbFindAllNotes' three branches exactly:
     *  - limitNotes: newest-first LIMIT n
     *  - tag filters: any-of(selectedTagIds) AND any-of(selectedORTagIds)
     *  - otherwise: everything
     */
    findAll(opts) {
      const {
        limitNotes,
        limit,
        selectedTagIds = [],
        selectedORTagIds = [],
      } = opts || {};
      if (limitNotes) {
        // uniqueid tie-break matches RxDB's deterministic sort (primary key
        // asc) — matters because bulk-imported file notes share lastModified.
        const rows = db
          .prepare(
            `SELECT doc FROM notes ORDER BY last_modified DESC, uniqueid ASC LIMIT ?`,
          )
          .all(Math.max(0, limit || 0));
        return docColumn(rows);
      }
      const clauses = [];
      const params = [];
      // Each EXISTS preserves RxDB's $elemMatch-$in semantics: the note has at
      // least ONE tag from the list. Both lists present => AND of the two.
      if (selectedTagIds.length > 0) {
        clauses.push(
          `EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.uniqueid AND t.tag_id IN (${placeholders(selectedTagIds.length)}))`,
        );
        params.push(...selectedTagIds);
      }
      if (selectedORTagIds.length > 0) {
        clauses.push(
          `EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.uniqueid AND t.tag_id IN (${placeholders(selectedORTagIds.length)}))`,
        );
        params.push(...selectedORTagIds);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT doc FROM notes n ${where} ORDER BY n.uniqueid`)
        .all(...params);
      return docColumn(rows);
    },

    /**
     * Newest-first notes for time-ordered surfaces (MCP `recent_notes`, "what
     * is the user working on now"). Unlike findAll({limitNotes}) this also takes
     * an optional `noteTypes` allow-list (indexed `note_type` column). Tag
     * EXCLUSION is intentionally NOT done here — callers strip by tag name from
     * the parsed docs (the junction stores ids, names live in the doc).
     */
    recent(opts) {
      const { limit = 50, noteTypes = [] } = opts || {};
      const lim = Math.max(0, Math.min(500, Number(limit) || 0));
      const types = Array.isArray(noteTypes)
        ? noteTypes.map((t) => String(t || '').trim()).filter(Boolean)
        : [];
      const where = types.length
        ? `WHERE note_type IN (${placeholders(types.length)})`
        : '';
      const rows = db
        .prepare(
          `SELECT doc FROM notes ${where} ORDER BY last_modified DESC, uniqueid ASC LIMIT ?`,
        )
        .all(...types, lim);
      return docColumn(rows);
    },

    /**
     * Newest notes carrying ANY of `tagIds` (a tag-name search resolves names →
     * ids first). Newest-first like recent(); used by search_local_notes' tag
     * leg to fold "the last N notes on these tags" into its combined result.
     */
    recentByTags(opts) {
      const { tagIds = [], limit = 30 } = opts || {};
      const ids = Array.isArray(tagIds)
        ? tagIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
      if (!ids.length) return [];
      const lim = Math.max(0, Math.min(200, Number(limit) || 0));
      const rows = db
        .prepare(
          `SELECT n.doc FROM notes n
           WHERE EXISTS (
             SELECT 1 FROM note_tags t
             WHERE t.note_id = n.uniqueid AND t.tag_id IN (${placeholders(ids.length)})
           )
           ORDER BY n.last_modified DESC, n.uniqueid ASC LIMIT ?`,
        )
        .all(...ids, lim);
      return docColumn(rows);
    },

    findByTag(tagId) {
      const rows = db
        .prepare(
          `SELECT n.doc FROM note_tags t JOIN notes n ON n.uniqueid = t.note_id WHERE t.tag_id = ?`,
        )
        .all(tagId);
      return docColumn(rows);
    },

    findIdsByIntegration(names) {
      if (!Array.isArray(names) || names.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT uniqueid FROM notes WHERE integration_name IN (${placeholders(names.length)})`,
        )
        .all(...names);
      return rows.map((r) => r.uniqueid);
    },

    /** Keyset pagination for full-corpus iteration (reindex/embeddings). */
    page(opts) {
      const { afterId = '', limit = 2000 } = opts || {};
      const rows = db
        .prepare(
          `SELECT doc FROM notes WHERE uniqueid > ? ORDER BY uniqueid LIMIT ?`,
        )
        .all(afterId, limit);
      return docColumn(rows);
    },

    /** Plain INSERT — throws on duplicate pk, matching RxDB insert(). */
    insert(docStr) {
      const n = prepareNote(docStr);
      withTransaction(db, () => {
        runUpsert(insertStmt, n);
        writeTagJunction(n);
      });
      return {
        data: null,
        change: { collection: 'notes', op: 'upsert', ids: [n.uniqueid] },
      };
    },

    upsert(docStr) {
      const n = prepareNote(docStr);
      withTransaction(db, () => {
        runUpsert(upsertStmt, n);
        writeTagJunction(n);
      });
      return {
        data: null,
        change: { collection: 'notes', op: 'upsert', ids: [n.uniqueid] },
      };
    },

    bulkUpsert(docStrs) {
      const prepared = docStrs.map(prepareNote);
      withTransaction(db, () => {
        for (const n of prepared) {
          runUpsert(upsertStmt, n);
          writeTagJunction(n);
        }
      });
      return {
        data: { count: prepared.length },
        change: {
          collection: 'notes',
          op: 'upsert',
          ids: prepared.map((n) => n.uniqueid),
        },
      };
    },

    /** Migration path: never clobbers a row the live path already wrote. */
    bulkInsertIgnore(docStrs) {
      const prepared = docStrs.map(prepareNote);
      let inserted = 0;
      const ids = [];
      withTransaction(db, () => {
        for (const n of prepared) {
          const res = runUpsert(insertIgnoreStmt, n);
          if (res.changes > 0) {
            inserted += 1;
            ids.push(n.uniqueid);
            writeTagJunction(n);
          }
        }
      });
      return {
        data: { inserted },
        change: { collection: 'notes', op: 'upsert', ids },
      };
    },

    /**
     * Shallow merge of the provided top-level keys onto the stored doc —
     * identical to RxDB incrementalUpdate({ $set: partial }). Returns the
     * merged doc, or null when the note doesn't exist (callers still fire
     * their backend sync in that case).
     */
    patch(id, partialStr) {
      const partial = parseDoc(partialStr, 'notes.patch');
      return withTransaction(db, () => {
        const row = findOneStmt.get(id);
        if (!row) return { data: null };
        const merged = { ...JSON.parse(row.doc), ...partial };
        merged.uniqueid = id; // pk is immutable
        const n = prepareNote(JSON.stringify(merged));
        runUpsert(upsertStmt, n);
        writeTagJunction(n);
        return {
          data: n.docStr,
          change: { collection: 'notes', op: 'upsert', ids: [id] },
        };
      });
    },

    /** Returns the deleted docs — callers need them for file/embedding cleanup. */
    bulkRemove(ids) {
      const deleted = [];
      withTransaction(db, () => {
        for (const part of chunk(ids, IN_CHUNK)) {
          const ph = placeholders(part.length);
          const rows = db
            .prepare(`DELETE FROM notes WHERE uniqueid IN (${ph}) RETURNING doc`)
            .all(...part);
          deleted.push(...docColumn(rows));
          db.prepare(`DELETE FROM note_tags WHERE note_id IN (${ph})`).run(
            ...part,
          );
        }
      });
      return {
        data: deleted,
        change: { collection: 'notes', op: 'delete', ids },
      };
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM notes`).get().n;
    },
  };
}

module.exports = { buildNotesRepo };
