import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allTrees, openDb, upsertTree, type DB } from "../src/store/db.js";

let db: DB;
let dir: string;

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function fresh(): DB {
  dir = mkdtempSync(join(tmpdir(), "pines-db-"));
  db = openDb(join(dir, "pines.db"));
  return db;
}

describe("upsertTree", () => {
  it("keys on session_path for updates", () => {
    const d = fresh();
    upsertTree(d, { tree_id: "t1", session_path: "/s/a.jsonl", node_count: 1 });
    upsertTree(d, { tree_id: "t_other", session_path: "/s/a.jsonl", node_count: 7 });
    const rows = allTrees(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tree_id).toBe("t1"); // path identity wins
    expect(rows[0]!.node_count).toBe(7);
  });

  it("rebinds a tree to a new session_path instead of duplicating tree_id", () => {
    // A live pi can move its record to a fresh session (/new inside pi).
    const d = fresh();
    upsertTree(d, {
      tree_id: "t1",
      session_path: "/s/old.jsonl",
      node_count: 5,
      ingest_offset: 999,
    });
    upsertTree(d, { tree_id: "t1", session_path: "/s/new.jsonl", node_count: 1 });
    const rows = allTrees(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_path).toBe("/s/new.jsonl");
    expect(rows[0]!.ingest_offset).toBe(0); // old file's offset must not carry over
  });
});
