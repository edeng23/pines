-- pines state store. Owned exclusively by the daemon. WAL mode.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS trees (
  tree_id             TEXT PRIMARY KEY,
  session_path        TEXT UNIQUE NOT NULL,
  session_id          TEXT,
  name                TEXT,
  cwd                 TEXT,
  parent_session_path TEXT,
  status              TEXT NOT NULL DEFAULT 'dormant',
  seen                INTEGER NOT NULL DEFAULT 1,
  leaf_id             TEXT,
  node_count          INTEGER NOT NULL DEFAULT 0,
  mtime               INTEGER NOT NULL DEFAULT 0,
  ingest_offset       INTEGER NOT NULL DEFAULT 0,
  embedding           BLOB,
  embedding_version   INTEGER NOT NULL DEFAULT 0,
  x                   REAL NOT NULL DEFAULT 0,
  y                   REAL NOT NULL DEFAULT 0,
  pinned              INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  last_screen         BLOB,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- One row per parent in v1 (plain lineage); n rows per graft in v2.
CREATE TABLE IF NOT EXISTS graft_parents (
  tree_id             TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  parent_session_path TEXT NOT NULL,
  parent_entry_id     TEXT,
  ordinal             INTEGER NOT NULL,
  PRIMARY KEY (tree_id, ordinal)
);

-- Per-chunk embedding cache: one row per embedded piece of a session (user
-- message, summary, or the name+labels/tools digests). chunk_key is the entry
-- id for message-anchored chunks, or a content-hashed 'meta:'/'tools:' key for
-- digest chunks, so incremental ingest embeds only what actually changed.
CREATE TABLE IF NOT EXISTS tree_chunks (
  tree_id   TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  chunk_key TEXT NOT NULL,
  kind      TEXT NOT NULL,      -- 'meta' | 'tools' | 'user' | 'summary'
  pos       INTEGER NOT NULL,   -- file-order index (recency weighting); -1 for digests
  embedding BLOB NOT NULL,      -- float32 vector, unit norm
  PRIMARY KEY (tree_id, chunk_key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  tree_id UNINDEXED,
  entry_id UNINDEXED,
  kind UNINDEXED,
  tokenize = 'porter unicode61'
);
