/** better-sqlite3 open/migrate for the daemon's state store. */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath, ensurePinesHome } from "../shared/paths.js";

export type DB = Database.Database;

const SCHEMA_VERSION = 3;

function schemaSql(): string {
  // dist/store/db.js → ../../src/store/schema.sql (schema ships as source).
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "src", "store", "schema.sql"), "utf8");
}

export function openDb(path = dbPath()): DB {
  ensurePinesHome();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(schemaSql());
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  } else {
    migrate(db, Number(row.value));
  }
  return db;
}

/**
 * Migration ladder for DBs created before the current schema. schema.sql is
 * IF NOT EXISTS throughout, so new tables already exist by the time we get
 * here — only in-place ALTERs live in the ladder.
 */
function migrate(db: DB, from: number): void {
  if (from >= SCHEMA_VERSION) return;
  // CREATE TABLE IF NOT EXISTS leaves existing tables untouched, so new
  // columns must be added explicitly — tolerating databases that already
  // have them (schema.sql creates the full shape on fresh installs).
  const addColumn = (sql: string): void => {
    try {
      db.exec(sql);
    } catch {
      // Column already present — fine.
    }
  };
  if (from < 2) {
    addColumn("ALTER TABLE trees ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (from < 3) {
    addColumn("ALTER TABLE trees ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0");
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
}

export interface TreeRow {
  tree_id: string;
  session_path: string;
  session_id: string | null;
  name: string | null;
  cwd: string | null;
  parent_session_path: string | null;
  status: string;
  seen: number;
  leaf_id: string | null;
  node_count: number;
  mtime: number;
  ingest_offset: number;
  embedding: Buffer | null;
  embedding_version: number;
  x: number;
  y: number;
  pinned: number;
  archived: number;
  last_screen: Buffer | null;
  created_at: number;
  updated_at: number;
}

export function allTrees(db: DB): TreeRow[] {
  return db.prepare("SELECT * FROM trees").all() as TreeRow[];
}

export function upsertTree(
  db: DB,
  row: Omit<Partial<TreeRow>, "tree_id" | "session_path"> & {
    tree_id: string;
    session_path: string;
  },
): void {
  const now = Date.now();
  const existing = db
    .prepare("SELECT tree_id FROM trees WHERE session_path = ?")
    .get(row.session_path) as { tree_id: string } | undefined;
  // A live pi can move its record to a new session file (/new inside pi):
  // no row has the new path, but the tree's identity row exists — rebind it
  // rather than INSERTing a tree_id duplicate. The offset belongs to the old
  // file, so it resets; the old file re-ingests as its own tree via watcher.
  const rebind = existing
    ? undefined
    : (db.prepare("SELECT tree_id FROM trees WHERE tree_id = ?").get(row.tree_id) as
        | { tree_id: string }
        | undefined);
  if (existing || rebind) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (k === "tree_id" || k === "session_path" || v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (rebind) {
      sets.push("session_path = ?");
      vals.push(row.session_path);
      if (row.ingest_offset === undefined) {
        sets.push("ingest_offset = 0");
      }
    }
    sets.push("updated_at = ?");
    vals.push(now, (existing ?? rebind)!.tree_id);
    db.prepare(`UPDATE trees SET ${sets.join(", ")} WHERE tree_id = ?`).run(...vals);
  } else {
    db.prepare(
      `INSERT INTO trees (tree_id, session_path, session_id, name, cwd, parent_session_path,
         status, seen, leaf_id, node_count, mtime, ingest_offset, x, y, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.tree_id,
      row.session_path,
      row.session_id ?? null,
      row.name ?? null,
      row.cwd ?? null,
      row.parent_session_path ?? null,
      row.status ?? "dormant",
      row.seen ?? 1,
      row.leaf_id ?? null,
      row.node_count ?? 0,
      row.mtime ?? now,
      row.ingest_offset ?? 0,
      row.x ?? 0,
      row.y ?? 0,
      row.archived ?? 0,
      now,
      now,
    );
  }
}

export function treeBySessionPath(db: DB, sessionPath: string): TreeRow | undefined {
  return db.prepare("SELECT * FROM trees WHERE session_path = ?").get(sessionPath) as
    | TreeRow
    | undefined;
}

/** Remove a tree and its contentless FTS rows. FK cascades its lineage rows. */
export function deleteTree(db: DB, treeId: string): void {
  db.transaction(() => {
    deleteFtsForTree(db, treeId);
    db.prepare("DELETE FROM trees WHERE tree_id = ?").run(treeId);
  })();
}

export function deleteFtsForTree(db: DB, treeId: string): void {
  db.prepare("DELETE FROM search_fts WHERE tree_id = ?").run(treeId);
}

export function insertFts(
  db: DB,
  rows: Array<{ text: string; treeId: string; entryId: string | null; kind: string }>,
): void {
  const stmt = db.prepare(
    "INSERT INTO search_fts (text, tree_id, entry_id, kind) VALUES (?, ?, ?, ?)",
  );
  const insertAll = db.transaction(() => {
    for (const r of rows) stmt.run(r.text, r.treeId, r.entryId, r.kind);
  });
  insertAll();
}

/** Zero-copy Float32Array view over an embedding BLOB. */
export function vectorOf(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export interface SimilarRow {
  tree_id: string;
  score: number;
}

/**
 * Top-k nearest trees to `treeId` by cosine over the pooled embeddings.
 * Vectors are unit-norm, so dot product == cosine. Brute force: a personal
 * forest is at most a few hundred 384-d vectors — microseconds, no index.
 */
export function similarTrees(db: DB, treeId: string, k = 8, minScore = 0.25): SimilarRow[] {
  const target = db
    .prepare("SELECT embedding FROM trees WHERE tree_id = ? AND embedding IS NOT NULL")
    .get(treeId) as { embedding: Buffer } | undefined;
  if (!target) return [];
  const t = vectorOf(target.embedding);
  const rows = db
    .prepare("SELECT tree_id, embedding FROM trees WHERE embedding IS NOT NULL AND tree_id != ?")
    .all(treeId) as Array<{ tree_id: string; embedding: Buffer }>;
  const scored: SimilarRow[] = [];
  for (const r of rows) {
    const v = vectorOf(r.embedding);
    if (v.length !== t.length) continue; // stale vector from another model
    let dot = 0;
    for (let i = 0; i < t.length; i++) dot += t[i]! * v[i]!;
    if (dot >= minScore) scored.push({ tree_id: r.tree_id, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export interface ChunkRow {
  chunk_key: string;
  kind: string;
  pos: number;
  embedding: Buffer;
}

export function chunksForTree(db: DB, treeId: string): ChunkRow[] {
  return db
    .prepare("SELECT chunk_key, kind, pos, embedding FROM tree_chunks WHERE tree_id = ? ORDER BY pos")
    .all(treeId) as ChunkRow[];
}

export function upsertChunks(
  db: DB,
  treeId: string,
  rows: Array<{ chunkKey: string; kind: string; pos: number; embedding: Buffer }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO tree_chunks (tree_id, chunk_key, kind, pos, embedding) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tree_id, chunk_key) DO UPDATE SET
       kind = excluded.kind, pos = excluded.pos, embedding = excluded.embedding`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(treeId, r.chunkKey, r.kind, r.pos, r.embedding);
  })();
}

export function deleteChunks(db: DB, treeId: string, chunkKeys: string[]): void {
  const stmt = db.prepare("DELETE FROM tree_chunks WHERE tree_id = ? AND chunk_key = ?");
  db.transaction(() => {
    for (const key of chunkKeys) stmt.run(treeId, key);
  })();
}

/** Keep the per-tree chunk cache bounded: drop the oldest user rows past `keep`. */
export function pruneUserChunks(db: DB, treeId: string, keep: number): void {
  db.prepare(
    `DELETE FROM tree_chunks WHERE tree_id = ? AND kind = 'user' AND chunk_key IN (
       SELECT chunk_key FROM tree_chunks WHERE tree_id = ? AND kind = 'user'
       ORDER BY pos DESC LIMIT -1 OFFSET ?)`,
  ).run(treeId, treeId, keep);
}

export interface FtsHit {
  tree_id: string;
  entry_id: string | null;
  kind: string;
  snippet: string;
  rank: number;
}

export function searchFts(db: DB, query: string, limit = 40, treeId?: string): FtsHit[] {
  // Escape user input into a quoted phrase-ish prefix query per token.
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replaceAll('"', '""')}"*`);
  if (tokens.length === 0) return [];
  const match = tokens.join(" ");
  const where = treeId ? "AND tree_id = ?" : "";
  const args: unknown[] = treeId ? [match, treeId, limit] : [match, limit];
  try {
    return db
      .prepare(
        `SELECT tree_id, entry_id, kind,
                snippet(search_fts, 0, '', '', '…', 12) AS snippet,
                rank
         FROM search_fts
         WHERE search_fts MATCH ? ${where}
         ORDER BY rank LIMIT ?`,
      )
      .all(...args) as FtsHit[];
  } catch {
    return []; // malformed MATCH input should never crash the daemon
  }
}
