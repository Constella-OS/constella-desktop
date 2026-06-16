/**
 * Misc repo (saved views + edge labels) — runs inside the db worker_thread
 * (plain CJS). Docs (MiscRxdbData shape) stored verbatim as JSON strings;
 * type/foreignId/date/startData/miscData are derived columns because the misc
 * CRUD layer queries and sorts on them.
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

// Mango-field -> extracted-column mapping for the additionalQuery translator.
const QUERYABLE_COLUMNS = {
  uniqueid: 'uniqueid',
  type: 'type',
  foreignId: 'foreign_id',
  date: 'date',
  startData: 'start_data',
  miscData: 'misc_data',
};

/**
 * Translate the tiny Mango subset rxdbGetMiscDataByType callers actually use
 * ($eq/$ne/$in/$exists or a bare literal) into SQL over extracted columns.
 * Anything outside the whitelist throws, so a future caller fails loudly in
 * dev instead of silently mismatching RxDB semantics.
 */
function translateAdditional(additional) {
  if (!additional || Object.keys(additional).length === 0) {
    return { sql: '', params: [] };
  }
  const clauses = [];
  const params = [];
  for (const [field, cond] of Object.entries(additional)) {
    const col = QUERYABLE_COLUMNS[field];
    if (!col) {
      throw new Error(
        `[main-db] misc additionalQuery on unsupported field '${field}' — extracted columns only`,
      );
    }
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      clauses.push(`${col} = ?`);
      params.push(cond);
      continue;
    }
    for (const [op, value] of Object.entries(cond)) {
      switch (op) {
        case '$eq':
          clauses.push(`${col} = ?`);
          params.push(value);
          break;
        case '$ne':
          // Mango $ne does not match missing fields either; NULL-safe compare.
          clauses.push(`(${col} IS NOT NULL AND ${col} != ?)`);
          params.push(value);
          break;
        case '$in': {
          const list = Array.isArray(value) ? value : [];
          clauses.push(`${col} IN (${placeholders(list.length)})`);
          params.push(...list);
          break;
        }
        case '$exists':
          clauses.push(value ? `${col} IS NOT NULL` : `${col} IS NULL`);
          break;
        default:
          throw new Error(
            `[main-db] misc additionalQuery operator '${op}' not supported`,
          );
      }
    }
  }
  return { sql: clauses.map((c) => `AND ${c}`).join(' '), params };
}

function buildMiscRepo(db) {
  const upsertStmt = db.prepare(
    `INSERT INTO misc(uniqueid,type,foreign_id,date,start_data,misc_data,doc)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(uniqueid) DO UPDATE SET
       type=excluded.type, foreign_id=excluded.foreign_id, date=excluded.date,
       start_data=excluded.start_data, misc_data=excluded.misc_data, doc=excluded.doc`,
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO misc(uniqueid,type,foreign_id,date,start_data,misc_data,doc)
     VALUES(?,?,?,?,?,?,?)`,
  );
  const findOneStmt = db.prepare(`SELECT doc FROM misc WHERE uniqueid = ?`);

  const str = (v) => (typeof v === 'string' ? v : null);
  const prepare = (docStr) => {
    const doc = parseDoc(docStr, 'misc');
    const uniqueid = requireUniqueid(doc, 'misc');
    if (stripRxInternals(doc)) docStr = JSON.stringify(doc);
    return {
      uniqueid,
      vals: [
        uniqueid,
        str(doc.type),
        str(doc.foreignId),
        str(doc.date),
        str(doc.startData),
        str(doc.miscData),
        docStr,
      ],
    };
  };

  // Shared $set-merge core for patch / patchByForeignId.
  const patchRow = (row, partialStr, label) => {
    const partial = parseDoc(partialStr, label);
    const existing = JSON.parse(row.doc);
    const merged = { ...existing, ...partial };
    merged.uniqueid = existing.uniqueid;
    const p = prepare(JSON.stringify(merged));
    upsertStmt.run(...p.vals);
    return {
      data: p.vals[p.vals.length - 1],
      change: { collection: 'misc', op: 'upsert', ids: [p.uniqueid] },
    };
  };

  return {
    findAll() {
      return docColumn(db.prepare(`SELECT doc FROM misc ORDER BY uniqueid`).all());
    },

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
                `SELECT doc FROM misc WHERE uniqueid IN (${placeholders(part.length)})`,
              )
              .all(...part),
          ),
        );
      }
      return out;
    },

    findByForeignIds(ids) {
      const out = [];
      for (const part of chunk(ids, IN_CHUNK)) {
        out.push(
          ...docColumn(
            db
              .prepare(
                `SELECT doc FROM misc WHERE foreign_id IN (${placeholders(part.length)})`,
              )
              .all(...part),
          ),
        );
      }
      return out;
    },

    findOneByForeignId(foreignId) {
      const row = db
        .prepare(`SELECT doc FROM misc WHERE foreign_id = ? LIMIT 1`)
        .get(foreignId);
      return row ? row.doc : null;
    },

    /** type filter + whitelisted additional conditions, date desc, opt LIMIT. */
    findByType(opts) {
      const { type, limit = null, additional } = opts || {};
      const extra = translateAdditional(additional);
      const limitSql =
        typeof limit === 'number' && limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
      const rows = db
        .prepare(
          `SELECT doc FROM misc WHERE type = ? ${extra.sql} ORDER BY date DESC ${limitSql}`,
        )
        .all(type, ...extra.params);
      return docColumn(rows);
    },

    upsert(docStr) {
      const p = prepare(docStr);
      upsertStmt.run(...p.vals);
      return {
        data: null,
        change: { collection: 'misc', op: 'upsert', ids: [p.uniqueid] },
      };
    },

    patch(id, partialStr) {
      return withTransaction(db, () => {
        const row = findOneStmt.get(id);
        if (!row) return { data: null };
        return patchRow(row, partialStr, 'misc.patch');
      });
    },

    patchByForeignId(foreignId, partialStr) {
      return withTransaction(db, () => {
        const row = db
          .prepare(`SELECT doc FROM misc WHERE foreign_id = ? LIMIT 1`)
          .get(foreignId);
        if (!row) return { data: null };
        return patchRow(row, partialStr, 'misc.patchByForeignId');
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
          collection: 'misc',
          op: 'upsert',
          ids: prepared.map((p) => p.uniqueid),
        },
      };
    },

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
      const deleted = [];
      withTransaction(db, () => {
        for (const part of chunk(ids, IN_CHUNK)) {
          deleted.push(
            ...docColumn(
              db
                .prepare(
                  `DELETE FROM misc WHERE uniqueid IN (${placeholders(part.length)}) RETURNING doc`,
                )
                .all(...part),
            ),
          );
        }
      });
      return { data: deleted, change: { collection: 'misc', op: 'delete', ids } };
    },

    /**
     * Case-insensitive substring over saved-view miscData, newest first.
     * The caller's $regex was always an escaped literal, so instr() is an
     * exact semantic match (and the savedView subset is tiny — scan is fine).
     */
    searchSavedViews(query) {
      const rows = db
        .prepare(
          `SELECT doc FROM misc
           WHERE type = 'savedView' AND misc_data IS NOT NULL
             AND instr(lower(misc_data), lower(?)) > 0
           ORDER BY date DESC`,
        )
        .all(query || '');
      return docColumn(rows);
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM misc`).get().n;
    },
  };
}

module.exports = { buildMiscRepo };
