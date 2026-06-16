/**
 * Repos for the small collections — tags, dailynotes, chats, chatmessages —
 * which share one shape: doc stored verbatim as a JSON string plus a couple
 * of derived scalar columns. Runs inside the db worker_thread (plain CJS).
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

const str = (v) => (typeof v === 'string' ? v : null);

/**
 * Build a generic small-collection repo over `table` with derived `columns`
 * (column name -> extractor fn). Collections add bespoke queries on top; the
 * worker only exposes what the shared DB_METHODS whitelist allows.
 */
function buildBaseRepo(db, table, collection, columns) {
  const colNames = Object.keys(columns);
  const allCols = ['uniqueid', ...colNames, 'doc'];
  const updates = [...colNames, 'doc']
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  const upsertStmt = db.prepare(
    `INSERT INTO ${table}(${allCols.join(',')}) VALUES(${placeholders(allCols.length)})
     ON CONFLICT(uniqueid) DO UPDATE SET ${updates}`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO ${table}(${allCols.join(',')}) VALUES(${placeholders(allCols.length)})`,
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO ${table}(${allCols.join(',')}) VALUES(${placeholders(allCols.length)})`,
  );
  const findOneStmt = db.prepare(`SELECT doc FROM ${table} WHERE uniqueid = ?`);

  const values = (docStr) => {
    const doc = parseDoc(docStr, table);
    const id = requireUniqueid(doc, table);
    if (stripRxInternals(doc)) docStr = JSON.stringify(doc);
    return { id, vals: [id, ...colNames.map((c) => columns[c](doc)), docStr] };
  };

  return {
    findAll() {
      return docColumn(
        db.prepare(`SELECT doc FROM ${table} ORDER BY uniqueid`).all(),
      );
    },

    findOne(id) {
      const row = findOneStmt.get(id);
      return row ? row.doc : null;
    },

    insert(docStr) {
      const { id, vals } = values(docStr);
      insertStmt.run(...vals);
      return { data: null, change: { collection, op: 'upsert', ids: [id] } };
    },

    upsert(docStr) {
      const { id, vals } = values(docStr);
      upsertStmt.run(...vals);
      return { data: null, change: { collection, op: 'upsert', ids: [id] } };
    },

    bulkUpsert(docStrs) {
      const prepared = docStrs.map(values);
      withTransaction(db, () => {
        for (const p of prepared) upsertStmt.run(...p.vals);
      });
      return {
        data: { count: prepared.length },
        change: { collection, op: 'upsert', ids: prepared.map((p) => p.id) },
      };
    },

    bulkInsertIgnore(docStrs) {
      const prepared = docStrs.map(values);
      let inserted = 0;
      withTransaction(db, () => {
        for (const p of prepared) {
          if (insertIgnoreStmt.run(...p.vals).changes > 0) inserted += 1;
        }
      });
      return { data: { inserted } };
    },

    /**
     * Shallow $set merge onto the stored doc (RxDB incrementalUpdate parity);
     * null when the row doesn't exist.
     */
    patch(id, partialStr) {
      const partial = parseDoc(partialStr, `${table}.patch`);
      return withTransaction(db, () => {
        const row = findOneStmt.get(id);
        if (!row) return { data: null };
        const merged = { ...JSON.parse(row.doc), ...partial };
        merged.uniqueid = id;
        const { vals } = values(JSON.stringify(merged));
        upsertStmt.run(...vals);
        return {
          data: vals[vals.length - 1],
          change: { collection, op: 'upsert', ids: [id] },
        };
      });
    },

    bulkRemove(ids) {
      const deleted = [];
      withTransaction(db, () => {
        for (const part of chunk(ids, IN_CHUNK)) {
          const rows = db
            .prepare(
              `DELETE FROM ${table} WHERE uniqueid IN (${placeholders(part.length)}) RETURNING doc`,
            )
            .all(...part);
          deleted.push(...docColumn(rows));
        }
      });
      return { data: deleted, change: { collection, op: 'delete', ids } };
    },

    count() {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },
  };
}

function buildTagsRepo(db) {
  return buildBaseRepo(db, 'tags', 'tags', {
    name: (d) => str(d.name),
    color: (d) => str(d.color),
  });
}

function buildDailynotesRepo(db) {
  const base = buildBaseRepo(db, 'dailynotes', 'dailynotes', {
    date: (d) => str(d.date),
  });
  return {
    ...base,

    /** Inclusive YYYY-MM-DD range, ascending — mirrors $gte/$lte + sort. */
    findByDateRange(opts) {
      return docColumn(
        db
          .prepare(
            `SELECT doc FROM dailynotes WHERE date BETWEEN ? AND ? ORDER BY date ASC`,
          )
          .all(opts.start, opts.end),
      );
    },

    findOneByDate(date) {
      const row = db
        .prepare(`SELECT doc FROM dailynotes WHERE date = ? LIMIT 1`)
        .get(date);
      return row ? row.doc : null;
    },

    /** Dates only — feeds rxdbDailyNotesCreatedDates without doc payloads. */
    allDates() {
      return db
        .prepare(`SELECT date FROM dailynotes`)
        .all()
        .map((r) => r.date)
        .filter((d) => typeof d === 'string');
    },
  };
}

function buildChatsRepo(db) {
  return buildBaseRepo(db, 'chats', 'chats', {
    date_updated: (d) => str(d.dateUpdated),
  });
}

function buildChatmessagesRepo(db) {
  const base = buildBaseRepo(db, 'chatmessages', 'chatmessages', {
    chat_id: (d) => str(d.chatId),
    date: (d) => str(d.date),
  });
  return {
    ...base,

    findByChatId(chatId) {
      return docColumn(
        db.prepare(`SELECT doc FROM chatmessages WHERE chat_id = ?`).all(chatId),
      );
    },

    /** Deletes a chat's messages, returns the count (RxDB .remove() parity). */
    deleteByChatId(chatId) {
      const rows = db
        .prepare(`DELETE FROM chatmessages WHERE chat_id = ? RETURNING uniqueid`)
        .all(chatId);
      const ids = rows.map((r) => r.uniqueid);
      return {
        data: ids.length,
        change: { collection: 'chatmessages', op: 'delete', ids },
      };
    },
  };
}

module.exports = {
  buildTagsRepo,
  buildDailynotesRepo,
  buildChatsRepo,
  buildChatmessagesRepo,
};
