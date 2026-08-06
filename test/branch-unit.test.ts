import { describe, expect, it } from "vitest";
import { branchInPlace, type BranchDeps } from "../src/daemon/branch.js";
import type { TreeRecord } from "../src/daemon/supervisor.js";

function fakeDeps(commandResult: { ok: boolean; err?: string }) {
  const queued: Array<[string, string]> = [];
  const written: string[] = [];
  const deps = {
    supervisor: { trees: new Map() },
    extBridge: {
      hasExtension: () => true,
      command: async () => commandResult,
    },
    queueNav: (treeId: string, nodeId: string) => queued.push([treeId, nodeId]),
    ingest: async () => undefined,
    setGraftParent: () => {},
    log: () => {},
  } as unknown as BranchDeps;
  const rec = {
    treeId: "t1",
    sessionPath: "/s/x.jsonl",
    agent: { isRunning: true, write: (s: string) => written.push(s) },
  } as unknown as TreeRecord;
  return { deps, rec, queued, written };
}

describe("in-place branch on a live agent", () => {
  it("queues the navigation instead of failing when the agent is busy", async () => {
    const { deps, rec, queued, written } = fakeDeps({ ok: false, err: "agent is busy" });
    const res = await branchInPlace(deps, rec, "node9");
    expect(res.ok).toBe(true); // multiplexing: the caller can still attach
    expect(res.note).toContain("when it settles");
    expect(queued).toEqual([["t1", "node9"]]);
    expect(written).toEqual([]); // no CR submitted into a busy pi
  });

  it("submits immediately when the agent is idle", async () => {
    const { deps, rec, queued, written } = fakeDeps({ ok: true });
    const res = await branchInPlace(deps, rec, "node9");
    expect(res.ok).toBe(true);
    expect(res.note).toBeUndefined();
    expect(queued).toEqual([]);
    expect(written).toEqual(["\r"]);
  });

  it("still fails plainly on non-busy extension errors", async () => {
    const { deps, rec } = fakeDeps({ ok: false, err: "navigate requires tui mode" });
    const res = await branchInPlace(deps, rec, "node9");
    expect(res.ok).toBe(false);
    expect(res.err).toContain("tui mode");
  });
});
