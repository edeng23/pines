/**
 * Incremental ingest: session JSONL → trees row + FTS index.
 *
 * JSONL is append-only, so we index only entries that appeared after the
 * stored ingest_offset. A file that shrank (e.g. replaced by a fork flow)
 * triggers a full re-ingest for that tree.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  deleteFtsForTree,
  insertFts,
  treeBySessionPath,
  upsertTree,
  type DB,
} from "../store/db.js";
import { parseSessionContent, parseSessionFile, type ParsedSession } from "./parser.js";

export interface IngestResult {
  treeId: string;
  parsed: ParsedSession;
  isNew: boolean;
  /** The session file's mtime — the honest "last activity" clock for the tree. */
  mtimeMs: number;
}

function ftsRowsFrom(parsed: ParsedSession, treeId: string, sinceByte: number): Array<{
  text: string;
  treeId: string;
  entryId: string | null;
  kind: string;
}> {
  // We re-derive which entries are "new" by parsing only the appended slice in
  // the caller; here parsed is already just that slice (or the whole file).
  void sinceByte;
  const rows: Array<{ text: string; treeId: string; entryId: string | null; kind: string }> = [];
  for (const e of parsed.entries) {
    if (e.type === "message" && e.role === "user" && e.text) {
      rows.push({ text: e.text, treeId, entryId: e.id, kind: "user_msg" });
    } else if ((e.type === "compaction" || e.type === "branch_summary") && e.text) {
      rows.push({ text: e.text, treeId, entryId: e.id, kind: "summary" });
    }
  }
  for (const [entryId, label] of parsed.labels) {
    rows.push({ text: label, treeId, entryId, kind: "label" });
  }
  return rows;
}

/**
 * Ingest one session file. Returns the treeId (existing or newly assigned)
 * and the full parse of the file. `preferredTreeId` is used only when the
 * session has no row yet (lets the daemon keep a spawn-time provisional id).
 */
export async function ingestSessionFile(
  db: DB,
  sessionPath: string,
  opts?: { preferredTreeId?: string },
): Promise<IngestResult> {
  const st = statSync(sessionPath);
  const existing = treeBySessionPath(db, sessionPath);
  const full = await parseSessionFile(sessionPath);

  let treeId: string;
  let isNew = false;
  let newRows: ReturnType<typeof ftsRowsFrom>;

  if (!existing) {
    treeId = opts?.preferredTreeId ?? `t_${randomUUID().slice(0, 8)}`;
    isNew = true;
    newRows = ftsRowsFrom(full, treeId, 0);
    if (full.name) newRows.push({ text: full.name, treeId, entryId: null, kind: "name" });
  } else {
    treeId = existing.tree_id;
    if (st.size < existing.ingest_offset) {
      // File shrank: full re-index.
      deleteFtsForTree(db, treeId);
      newRows = ftsRowsFrom(full, treeId, 0);
      if (full.name) newRows.push({ text: full.name, treeId, entryId: null, kind: "name" });
    } else if (full.completeBytes > existing.ingest_offset) {
      // Parse only the appended slice for FTS deltas (labels in the slice are
      // additive; full.labels remains authoritative for display).
      const slice = readFileSync(sessionPath).subarray(existing.ingest_offset).toString("utf8");
      const appended = await parseSessionContent(slice);
      newRows = ftsRowsFrom(appended, treeId, existing.ingest_offset);
      const knownName = existing.name ?? null;
      if (full.name && full.name !== knownName) {
        newRows.push({ text: full.name, treeId, entryId: null, kind: "name" });
      }
    } else {
      newRows = [];
    }
  }

  upsertTree(db, {
    tree_id: treeId,
    session_path: sessionPath,
    session_id: full.header.sessionId,
    name: full.name,
    cwd: full.header.cwd,
    parent_session_path: full.header.parentSession,
    leaf_id: full.leafId,
    node_count: full.entries.length,
    mtime: Math.floor(st.mtimeMs),
    ingest_offset: full.completeBytes,
  });

  if (isNew) {
    // Lineage row (ordinal 0) — graft (v2) adds more ordinals.
    if (full.header.parentSession) {
      db.prepare(
        "INSERT OR IGNORE INTO graft_parents (tree_id, parent_session_path, parent_entry_id, ordinal) VALUES (?, ?, NULL, 0)",
      ).run(treeId, full.header.parentSession);
    }
  }

  if (newRows.length > 0) insertFts(db, newRows);

  return { treeId, parsed: full, isNew, mtimeMs: Math.floor(st.mtimeMs) };
}
