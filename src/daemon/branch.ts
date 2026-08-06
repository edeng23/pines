/**
 * Branch-from-node orchestration.
 *
 * Ownership rule: a live tree's JSONL is written only by its pi process (we go
 * through the extension); dormant trees are written by the daemon via pi's SDK.
 * Pines never hand-writes session JSONL.
 */
import { existsSync } from "node:fs";
import type { ExtBridge } from "./extbridge.js";
import type { Supervisor, TreeRecord } from "./supervisor.js";

export interface BranchDeps {
  supervisor: Supervisor;
  extBridge: ExtBridge;
  /** Queue an in-place navigation to run when the (busy) agent settles. */
  queueNav?: (treeId: string, nodeId: string) => void;
  /** Re-ingest a session file and return its (possibly new) record. */
  ingest: (sessionPath: string, preferredTreeId?: string) => Promise<TreeRecord | undefined>;
  setGraftParent: (treeId: string, parentSessionPath: string, parentEntryId: string) => void;
  log: (msg: string) => void;
}

export interface BranchResult {
  ok: boolean;
  err?: string;
  /** Caveat on an ok result (e.g. navigation queued behind a busy agent). */
  note?: string;
  newTreeId?: string;
}

async function piSdk() {
  return import("@earendil-works/pi-coding-agent");
}

/**
 * In-place branch: move the tree's leaf to `nodeId` so the next message
 * continues from that context, inside the same session file.
 */
export async function branchInPlace(
  deps: BranchDeps,
  rec: TreeRecord,
  nodeId: string,
): Promise<BranchResult> {
  if (rec.agent?.isRunning) {
    if (!deps.extBridge.hasExtension(rec.treeId)) {
      return { ok: false, err: "live agent has no pines extension connected" };
    }
    // Extension stages `/pines-nav <id>` in pi's editor (navigateTree needs a
    // user-initiated command context); we submit it by sending CR to the PTY.
    const res = await deps.extBridge.command(rec.treeId, {
      op: "navigate_tree",
      targetId: nodeId,
    });
    if (!res.ok) {
      // Multiplexing must never block on a generating agent: queue the move
      // and let the daemon run it the moment the agent settles.
      if (res.err?.includes("busy") && deps.queueNav) {
        deps.queueNav(rec.treeId, nodeId);
        return {
          ok: true,
          note: "agent is mid-task — will continue from that node when it settles",
          newTreeId: rec.treeId,
        };
      }
      return { ok: false, err: res.err };
    }
    rec.agent.write("\r");
    return { ok: true, newTreeId: rec.treeId };
  }

  if (!rec.sessionPath) return { ok: false, err: "tree has no session file" };
  try {
    const { SessionManager } = await piSdk();
    const sm = SessionManager.open(rec.sessionPath);
    if (!sm.getEntry(nodeId)) return { ok: false, err: `no entry ${nodeId} in session` };
    sm.branch(nodeId);
    // branch() only moves the in-memory pointer; append a pines marker (not in
    // LLM context) so the new leaf position survives the next resume.
    sm.appendCustomEntry("pines.branch", { from: nodeId, treeId: rec.treeId });
    await deps.ingest(rec.sessionPath);
    return { ok: true, newTreeId: rec.treeId };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * New-tree branch: materialize the root→node path as a fresh session file
 * (pi's createBranchedSession), register it, optionally spawn a pi on it.
 */
export async function branchToNewTree(
  deps: BranchDeps,
  rec: TreeRecord,
  nodeId: string,
  opts: { spawn: boolean; cols?: number; rows?: number },
): Promise<BranchResult> {
  if (!rec.sessionPath) return { ok: false, err: "tree has no session file" };
  try {
    const { SessionManager } = await piSdk();
    // Reading the source is safe while a pi appends (append-only file).
    const sm = SessionManager.open(rec.sessionPath);
    if (!sm.getEntry(nodeId)) return { ok: false, err: `no entry ${nodeId} in session` };
    const newPath = sm.createBranchedSession(nodeId);
    if (!newPath) return { ok: false, err: "createBranchedSession returned nothing" };
    if (!existsSync(newPath)) {
      // pi SDK edge case: branching from the session's first entry returns a
      // path without ever writing the file. Surface it honestly.
      return {
        ok: false,
        err: "pi wrote no branch file for this node — branching from the first entry isn't supported, pick a later node",
      };
    }

    const newRec = await deps.ingest(newPath);
    if (!newRec) return { ok: false, err: "failed to ingest branched session" };
    newRec.parentSessionPath ??= rec.sessionPath;
    deps.setGraftParent(newRec.treeId, rec.sessionPath, nodeId);
    // Seed the new tree's position near its parent so it sprouts visibly
    // adjacent instead of waiting for a relayout. Siblings fan out around the
    // parent (golden-angle steps) instead of stacking on one spot.
    if (newRec.x === 0 && newRec.y === 0) {
      const siblings = [...deps.supervisor.trees.values()].filter(
        (t) => t.parentSessionPath === rec.sessionPath && t.treeId !== newRec.treeId,
      ).length;
      const angle = 0.7 + siblings * 2.399963;
      const r = 2.6 + 0.4 * siblings;
      newRec.x = rec.x + r * Math.cos(angle);
      newRec.y = rec.y + r * Math.sin(angle);
    }
    deps.supervisor.notify(newRec);

    if (opts.spawn) {
      if (!newRec.cwd) return { ok: false, err: "branched session has no cwd" };
      if (!existsSync(newRec.cwd)) {
        // The branched tree itself is fine — only the agent can't start.
        return {
          ok: false,
          err: `branched, but cwd no longer exists: ${newRec.cwd} — agent not spawned`,
          newTreeId: newRec.treeId,
        };
      }
      deps.supervisor.spawnAgent({
        cwd: newRec.cwd,
        sessionPath: newPath,
        existing: newRec,
        cols: opts.cols,
        rows: opts.rows,
      });
    }
    return { ok: true, newTreeId: newRec.treeId };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

/** Set or clear a label on a node, honoring the ownership rule. */
export async function setNodeLabel(
  deps: BranchDeps,
  rec: TreeRecord,
  nodeId: string,
  label: string | null,
): Promise<BranchResult> {
  if (rec.agent?.isRunning && deps.extBridge.hasExtension(rec.treeId)) {
    const res = await deps.extBridge.command(rec.treeId, {
      op: "set_label",
      entryId: nodeId,
      label,
    });
    return { ok: res.ok, err: res.err };
  }
  if (!rec.sessionPath) return { ok: false, err: "tree has no session file" };
  try {
    const { SessionManager } = await piSdk();
    const sm = SessionManager.open(rec.sessionPath);
    sm.appendLabelChange(nodeId, label ?? undefined);
    await deps.ingest(rec.sessionPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}
