/**
 * Schema migration: a v1 store (no `archived` column) opened by the current
 * code gains the column without losing rows; fresh stores start at the current version.
 */
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTrees, openDb, upsertTree } from "../src/store/db.js";

const homes: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pines-db-"));
  homes.push(dir);
  return join(dir, "state.db");
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

/** The trees table exactly as v1 shipped it (no `archived`). */
const V1_SCHEMA = `
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
`;

describe("db migration", () => {
  it("upgrades a v1 store in place: archived column appears, rows survive", () => {
    const path = tempDbPath();
    const v1 = new Database(path);
    v1.exec(V1_SCHEMA);
    v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    v1.prepare(
      "INSERT INTO trees (tree_id, session_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("t_old", "/s/old.jsonl", "old-tree", 1, 1);
    v1.close();

    const db = openDb(path);
    const rows = allTrees(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("old-tree");
    expect(rows[0]!.archived).toBe(0);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe("3");

    // The migrated store round-trips the new field.
    upsertTree(db, { tree_id: "t_old", session_path: "/s/old.jsonl", archived: 1 });
    expect(allTrees(db)[0]!.archived).toBe(1);
    db.close();
  });

  it("creates fresh stores at the current version with archived persisting through upsert", () => {
    const path = tempDbPath();
    const db = openDb(path);
    upsertTree(db, { tree_id: "t_new", session_path: "/s/new.jsonl", archived: 1 });
    expect(allTrees(db)[0]!.archived).toBe(1);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe("3");
    db.close();
  });
});
