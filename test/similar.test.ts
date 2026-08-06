/**
 * Tree similarity + chunk cache + schema migration: cosine ranking over pooled
 * embeddings, the tree_chunks helpers backing incremental embedding, and the
 * migration ladder to the current version (archived + embedding_version columns, tree_chunks table).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunksForTree,
  deleteChunks,
  openDb,
  pruneUserChunks,
  similarTrees,
  upsertChunks,
  upsertTree,
  vectorOf,
} from "../src/store/db.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pines-db-")), "pines.db");
}

/** Unit vector concentrated on one axis-ish direction. */
function unitVec(dim: number, hot: number, lean = 1): Buffer {
  const v = new Float32Array(dim);
  v[hot] = 1;
  v[(hot + 1) % dim] = lean * 0.3;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < dim; i++) v[i] = v[i]! / n;
  return Buffer.from(v.buffer);
}

function addTree(db: ReturnType<typeof openDb>, id: string, embedding: Buffer | null): void {
  upsertTree(db, { tree_id: id, session_path: `/s/${id}.jsonl` });
  if (embedding) {
    db.prepare("UPDATE trees SET embedding = ? WHERE tree_id = ?").run(embedding, id);
  }
}

describe("similarTrees", () => {
  it("ranks neighbors by cosine, excludes self, applies the score floor", () => {
    const db = openDb(tmpDbPath());
    const DIM = 384;
    addTree(db, "t_anchor", unitVec(DIM, 10));
    addTree(db, "t_close", unitVec(DIM, 10, 2)); // same direction, slight lean
    addTree(db, "t_near", unitVec(DIM, 11)); // shares the lean axis a bit
    addTree(db, "t_far", unitVec(DIM, 200)); // orthogonal → below floor
    addTree(db, "t_noembed", null);

    const hits = similarTrees(db, "t_anchor", 8);
    const ids = hits.map((h) => h.tree_id);
    expect(ids[0]).toBe("t_close");
    expect(ids).not.toContain("t_anchor");
    expect(ids).not.toContain("t_far"); // cosine ~0 < 0.25 floor
    expect(ids).not.toContain("t_noembed");
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    db.close();
  });

  it("returns [] for a tree with no embedding and skips mismatched dimensions", () => {
    const db = openDb(tmpDbPath());
    addTree(db, "t_a", null);
    addTree(db, "t_b", unitVec(384, 5));
    addTree(db, "t_other_model", unitVec(768, 5)); // stale vector, other dim
    expect(similarTrees(db, "t_a")).toEqual([]);
    expect(similarTrees(db, "t_b").map((h) => h.tree_id)).not.toContain("t_other_model");
    db.close();
  });
});

describe("tree_chunks helpers", () => {
  it("upserts, reads back in pos order, deletes, and prunes old user chunks", () => {
    const db = openDb(tmpDbPath());
    addTree(db, "t1", null);
    upsertChunks(db, "t1", [
      { chunkKey: "meta:abc", kind: "meta", pos: -1, embedding: unitVec(4, 0) },
      ...Array.from({ length: 10 }, (_, i) => ({
        chunkKey: `u${i}`,
        kind: "user",
        pos: i,
        embedding: unitVec(4, i % 4),
      })),
    ]);
    const rows = chunksForTree(db, "t1");
    expect(rows).toHaveLength(11);
    expect(rows[0]!.chunk_key).toBe("meta:abc"); // pos -1 sorts first
    expect(vectorOf(rows[0]!.embedding)).toHaveLength(4);

    deleteChunks(db, "t1", ["u0", "u1"]);
    expect(chunksForTree(db, "t1")).toHaveLength(9);

    pruneUserChunks(db, "t1", 3); // keep newest 3 user chunks
    const left = chunksForTree(db, "t1");
    expect(left.filter((r) => r.kind === "user").map((r) => r.chunk_key)).toEqual([
      "u7",
      "u8",
      "u9",
    ]);
    expect(left.some((r) => r.kind === "meta")).toBe(true); // meta untouched
    db.close();
  });

  it("cascades chunk rows when the tree is deleted", () => {
    const db = openDb(tmpDbPath());
    addTree(db, "t1", null);
    upsertChunks(db, "t1", [{ chunkKey: "u0", kind: "user", pos: 0, embedding: unitVec(4, 0) }]);
    db.prepare("DELETE FROM trees WHERE tree_id = ?").run("t1");
    expect(chunksForTree(db, "t1")).toHaveLength(0);
    db.close();
  });
});

describe("schema migration from v1", () => {
  /** Hand-build a database exactly as schema v1 created it. */
  function buildV1(path: string): void {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE trees (
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
        x                   REAL NOT NULL DEFAULT 0,
        y                   REAL NOT NULL DEFAULT 0,
        pinned              INTEGER NOT NULL DEFAULT 0,
        last_screen         BLOB,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE TABLE graft_parents (
        tree_id             TEXT NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
        parent_session_path TEXT NOT NULL,
        parent_entry_id     TEXT,
        ordinal             INTEGER NOT NULL,
        PRIMARY KEY (tree_id, ordinal)
      );
      CREATE VIRTUAL TABLE search_fts USING fts5(
        text, tree_id UNINDEXED, entry_id UNINDEXED, kind UNINDEXED,
        tokenize = 'porter unicode61'
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO trees (tree_id, session_path, created_at, updated_at)
        VALUES ('t_old', '/s/old.jsonl', 0, 0);
    `);
    db.close();
  }

  it("upgrades a v1 store in place and is idempotent on reopen", () => {
    const path = tmpDbPath();
    buildV1(path);

    let db = openDb(path);
    // Column added with default 0, old rows intact.
    const row = db
      .prepare("SELECT tree_id, embedding_version FROM trees WHERE tree_id = 't_old'")
      .get() as { tree_id: string; embedding_version: number };
    expect(row.embedding_version).toBe(0);
    // New table exists and version stamped.
    expect(chunksForTree(db, "t_old")).toEqual([]);
    const ver = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(ver.value).toBe("3");
    db.close();

    db = openDb(path); // reopen: no throw, still v2
    expect(
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe("3");
    db.close();
  });
});
