/**
 * Shared low-level helpers for the main-DB worker repos.
 *
 * Plain CJS on purpose: the worker subtree runs as raw source in dev (no
 * tsx/webpack in the worker thread) and is webpack-bundled for prod — same
 * convention as src/main/ai/workers. Everything here runs INSIDE the db
 * worker_thread (synchronous node:sqlite), never on main's JS thread. Docs
 * are handled as raw JSON strings; a repo parses a doc exactly once on write
 * to derive its index columns.
 */

// SQLITE_MAX_VARIABLE_NUMBER is 32766 in modern SQLite but we stay far below
// it so a single IN(...) statement never balloons.
const IN_CHUNK = 500;

/** Split an array into chunks of at most `size` items. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** '?,?,?' placeholder list for an IN clause. */
function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/**
 * Run `fn` inside a single transaction; rolls back on throw. node:sqlite has
 * no transaction helper, so this wraps BEGIN/COMMIT/ROLLBACK. Batched writes
 * MUST use this — one commit per batch is what keeps writes low-millisecond.
 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

/**
 * Parse a DocString into an object, throwing a descriptive error instead of
 * a bare SyntaxError so the renderer sees which collection/payload broke.
 */
function parseDoc(docStr, label) {
  if (typeof docStr !== 'string' || docStr.length === 0) {
    throw new Error(`[main-db] ${label}: expected a JSON doc string`);
  }
  const doc = JSON.parse(docStr);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`[main-db] ${label}: doc must be a JSON object`);
  }
  return doc;
}

// RxDB storage internals that may ride along on docs read straight out of
// IndexedDB (_data of an RxDocument). They're meaningless outside RxDB and
// must never persist in sqlite.
const RX_INTERNAL_FIELDS = ['_attachments', '_deleted', '_meta', '_rev'];

/**
 * Delete RxDB-internal fields from a parsed doc (mutates). Returns true when
 * anything was removed so callers know to re-serialize.
 */
function stripRxInternals(doc) {
  let stripped = false;
  for (const f of RX_INTERNAL_FIELDS) {
    if (f in doc) {
      delete doc[f];
      stripped = true;
    }
  }
  return stripped;
}

/** Cheap write guard replacing RxDB's AJV layer: pk must be a real string. */
function requireUniqueid(doc, label) {
  const id = doc.uniqueid;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`[main-db] ${label}: doc is missing a string uniqueid`);
  }
  return id;
}

/** Map SELECT rows of `{ doc }` to the raw DocString array we ship out. */
function docColumn(rows) {
  return rows.map((r) => r.doc);
}

module.exports = {
  IN_CHUNK,
  chunk,
  placeholders,
  withTransaction,
  parseDoc,
  requireUniqueid,
  stripRxInternals,
  docColumn,
};
