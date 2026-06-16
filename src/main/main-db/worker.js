/**
 * Main-DB worker — the ONLY place node:sqlite runs.
 *
 * Lives in a worker_thread inside the main process so synchronous SQLite work
 * (bulk upserts, multi-MB doc reads, migration batches) never blocks main's
 * event loop — blocking main for even ~10ms visibly janks renderer animations
 * in every window (electron#9719). Spawned + supervised by ./db.ts.
 *
 * Plain CJS .js on purpose (same convention as src/main/ai/workers): in dev
 * the worker loads this source file directly (no tsx/webpack inside worker
 * threads), in packaged builds webpack bundles it as dist/main/db-worker.js.
 *
 * Protocol (structured-clone messages, see src/shared/main-db-api.ts):
 *   in : { id, collection, method, args }
 *   out: { id, ok: true, data, change? } | { id, ok: false, error }
 *   in : { type: 'close' }   -> checkpoint + close, replies { type: 'closed' }
 *   out: { type: 'ready' }   once the DB is open and the registry is built
 *
 * Repo methods either return a plain value (reads) or a { data, change }
 * envelope (writes) — the dispatcher unwraps the latter so main can broadcast
 * the change to renderers AFTER the write committed. The callable-method
 * whitelist (DB_METHODS in src/shared/main-db-api.ts) is enforced by the IPC
 * bridge before anything reaches this thread.
 *
 * No electron imports here (workers can't use them): the DB directory comes
 * from main via workerData.dbDir.
 */
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const { buildNotesRepo } = require('./repos/notes');
const { buildNoteBodiesRepo } = require('./repos/noteBodies');
const { buildMiscRepo } = require('./repos/misc');
const { buildCanvasesRepo } = require('./repos/canvases');
const {
  buildTagsRepo,
  buildDailynotesRepo,
  buildChatsRepo,
  buildChatmessagesRepo,
} = require('./repos/simple');

const SCHEMA_VERSION = 1;

/** Open the DB, apply pragmas + DDL. Synchronous, runs once at startup. */
function openDb(dbDir) {
  fs.mkdirSync(dbDir, { recursive: true });
  // Lazy require so webpack (electron-main target) externalizes the builtin
  // instead of trying to bundle it — same trick as file-graph/graphDb.ts.
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dbDir, 'constella.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // Cap WAL growth between checkpoints (we only TRUNCATE-checkpoint at close).
  db.exec('PRAGMA journal_size_limit = 67108864;'); // 64 MB
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS notes (
      uniqueid         TEXT PRIMARY KEY,
      title            TEXT NOT NULL DEFAULT '',
      note_type        TEXT,
      integration_name TEXT,
      subtype          TEXT,
      created          INTEGER,
      last_modified    INTEGER,
      doc              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_last_modified ON notes(last_modified DESC);
    CREATE INDEX IF NOT EXISTS notes_integration   ON notes(integration_name);

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL,
      tag_id  TEXT NOT NULL,
      PRIMARY KEY (tag_id, note_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS note_tags_note ON note_tags(note_id);

    CREATE TABLE IF NOT EXISTS note_bodies (
      uniqueid      TEXT PRIMARY KEY,
      reference_id  TEXT,
      type          TEXT,
      created       INTEGER,
      last_modified INTEGER,
      doc           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_bodies_ref ON note_bodies(reference_id);

    CREATE TABLE IF NOT EXISTS tags (
      uniqueid TEXT PRIMARY KEY,
      name     TEXT,
      color    TEXT,
      doc      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dailynotes (
      uniqueid TEXT PRIMARY KEY,
      date     TEXT,
      doc      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dailynotes_date ON dailynotes(date);

    CREATE TABLE IF NOT EXISTS chats (
      uniqueid     TEXT PRIMARY KEY,
      date_updated TEXT,
      doc          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chatmessages (
      uniqueid TEXT PRIMARY KEY,
      chat_id  TEXT,
      date     TEXT,
      doc      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chatmessages_chat ON chatmessages(chat_id);

    CREATE TABLE IF NOT EXISTS misc (
      uniqueid   TEXT PRIMARY KEY,
      type       TEXT,
      foreign_id TEXT,
      date       TEXT,
      start_data TEXT,
      misc_data  TEXT,
      doc        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS misc_type_date ON misc(type, date DESC);
    CREATE INDEX IF NOT EXISTS misc_foreign   ON misc(foreign_id);

    CREATE TABLE IF NOT EXISTS canvases (
      uniqueid         TEXT PRIMARY KEY,
      name             TEXT NOT NULL DEFAULT '',
      description      TEXT,
      node_count       INTEGER,
      card_theme_color TEXT,
      card_emoji       TEXT,
      created_at       TEXT,
      updated_at       TEXT,
      preview_nodes    TEXT,
      doc              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS canvases_updated ON canvases(updated_at DESC);
  `);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run(String(SCHEMA_VERSION));
  return db;
}

function buildMetaRepo(db) {
  return {
    get(key) {
      const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
      return row ? row.value : null;
    },
    set(opts) {
      db.prepare(
        `INSERT INTO meta(key, value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run(opts.key, String(opts.value));
      return { data: null };
    },
  };
}

const db = openDb(workerData && workerData.dbDir);

const registry = {
  notes: buildNotesRepo(db),
  noteBodies: buildNoteBodiesRepo(db),
  tags: buildTagsRepo(db),
  dailynotes: buildDailynotesRepo(db),
  chats: buildChatsRepo(db),
  chatmessages: buildChatmessagesRepo(db),
  misc: buildMiscRepo(db),
  canvases: buildCanvasesRepo(db),
  meta: buildMetaRepo(db),
};

/** True for write results that carry a change notification envelope. */
function isEnvelope(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'data' in v;
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  // Graceful shutdown: truncate the WAL so the next boot starts clean.
  if (msg.type === 'close') {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
    } catch {
      /* closing best-effort */
    }
    parentPort.postMessage({ type: 'closed' });
    return;
  }

  const { id, collection, method, args } = msg;
  if (typeof id !== 'number') return;
  try {
    const repo = registry[collection];
    if (!repo || typeof repo[method] !== 'function') {
      throw new Error(`[main-db] unknown method ${collection}.${method}`);
    }
    const result = repo[method](...(Array.isArray(args) ? args : []));
    if (isEnvelope(result)) {
      parentPort.postMessage({ id, ok: true, data: result.data, change: result.change });
    } else {
      parentPort.postMessage({ id, ok: true, data: result });
    }
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
});

parentPort.postMessage({ type: 'ready' });
