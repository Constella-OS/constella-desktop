/**
 * Note-bodies (chunk) repo — runs inside the db worker_thread (plain CJS).
 *
 * Chunk docs (NoteBodyRxdbData shape) stored verbatim as JSON strings; the
 * reference_id/type/timestamps columns are derived projections. Vectors are
 * stripped on write like notes (LanceDB owns chunk vectors).
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

function prepareBody(docStr) {
  const doc = parseDoc(docStr, 'noteBodies');
  const uniqueid = requireUniqueid(doc, 'noteBodies');
  const stripped = stripRxInternals(doc);
  const stripVector =
    !PERSIST_VECTORS && Array.isArray(doc.vector) && doc.vector.length > 0;
  if (stripVector) doc.vector = [];
  if (stripped || stripVector) docStr = JSON.stringify(doc);
  return {
    uniqueid,
    referenceId: typeof doc.referenceId === 'string' ? doc.referenceId : null,
    type: typeof doc.type === 'string' ? doc.type : null,
    created: typeof doc.created === 'number' ? doc.created : null,
    lastModified: typeof doc.lastModified === 'number' ? doc.lastModified : null,
    docStr,
  };
}

function buildNoteBodiesRepo(db) {
  const upsertStmt = db.prepare(
    `INSERT INTO note_bodies(uniqueid,reference_id,type,created,last_modified,doc)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(uniqueid) DO UPDATE SET
       reference_id=excluded.reference_id, type=excluded.type,
       created=excluded.created, last_modified=excluded.last_modified,
       doc=excluded.doc`,
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO note_bodies(uniqueid,reference_id,type,created,last_modified,doc)
     VALUES(?,?,?,?,?,?)`,
  );

  const run = (stmt, b) =>
    stmt.run(b.uniqueid, b.referenceId, b.type, b.created, b.lastModified, b.docStr);

  return {
    findByIds(ids) {
      const out = [];
      for (const part of chunk(ids, IN_CHUNK)) {
        const rows = db
          .prepare(
            `SELECT doc FROM note_bodies WHERE uniqueid IN (${placeholders(part.length)})`,
          )
          .all(...part);
        out.push(...docColumn(rows));
      }
      return out;
    },

    // All chunk ids for one parent note (reference_id is an indexed column).
    // Used by the note→graph chunk-sync diff to find which chunks already exist.
    findIdsByReference(referenceId) {
      const rows = db
        .prepare(`SELECT uniqueid FROM note_bodies WHERE reference_id = ?`)
        .all(referenceId);
      return rows.map((r) => r.uniqueid);
    },

    page(opts) {
      const { afterId = '', limit = 2000 } = opts || {};
      const rows = db
        .prepare(
          `SELECT doc FROM note_bodies WHERE uniqueid > ? ORDER BY uniqueid LIMIT ?`,
        )
        .all(afterId, limit);
      return docColumn(rows);
    },

    bulkUpsert(docStrs) {
      const prepared = docStrs.map(prepareBody);
      withTransaction(db, () => {
        for (const b of prepared) run(upsertStmt, b);
      });
      return {
        data: { count: prepared.length },
        change: {
          collection: 'noteBodies',
          op: 'upsert',
          ids: prepared.map((b) => b.uniqueid),
        },
      };
    },

    bulkInsertIgnore(docStrs) {
      const prepared = docStrs.map(prepareBody);
      let inserted = 0;
      withTransaction(db, () => {
        for (const b of prepared) {
          if (run(insertIgnoreStmt, b).changes > 0) inserted += 1;
        }
      });
      return { data: { inserted } };
    },

    bulkRemove(ids) {
      const deleted = [];
      withTransaction(db, () => {
        for (const part of chunk(ids, IN_CHUNK)) {
          const rows = db
            .prepare(
              `DELETE FROM note_bodies WHERE uniqueid IN (${placeholders(part.length)}) RETURNING doc`,
            )
            .all(...part);
          deleted.push(...docColumn(rows));
        }
      });
      return {
        data: deleted,
        change: { collection: 'noteBodies', op: 'delete', ids },
      };
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM note_bodies`).get().n;
    },
  };
}

module.exports = { buildNoteBodiesRepo };
